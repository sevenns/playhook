// The network client's rules, exercised with a fake fetch (no test touches the network — the whole
// reason HttpClient takes `fetch` through deps).
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { HttpClient, type FetchInit, type FetchResponse } from '../src/main/metadata/http';

function bodyOf(chunks: readonly Uint8Array[]): FetchResponse['body'] {
  let index = 0;
  return {
    getReader: () => ({
      read: async () => {
        const value = chunks[index];
        if (value === undefined) return { done: true };
        index += 1;
        return { done: false, value };
      },
      cancel: async () => undefined,
    }),
  };
}

function respond(text: string, init?: { status?: number; contentType?: string }): FetchResponse {
  const status = init?.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name) => (name.toLowerCase() === 'content-type' ? (init?.contentType ?? null) : null),
    },
    body: bodyOf([new TextEncoder().encode(text)]),
  };
}

function clientOf(fetch: (url: string, init?: FetchInit) => Promise<FetchResponse>): HttpClient {
  return new HttpClient({ fetch, userAgent: 'Playhook/test' });
}

describe('metadata http client', () => {
  it('validates a JSON answer against the schema', async () => {
    const client = clientOf(async () =>
      respond('{"total":1,"items":[{"id":220,"name":"Half-Life 2"}]}'),
    );
    const schema = z.object({ items: z.array(z.object({ id: z.number(), name: z.string() })) });
    const result = await client.json('https://example.test/search', schema);
    expect(result).toEqual({ ok: true, value: { items: [{ id: 220, name: 'Half-Life 2' }] } });
  });

  it('fails a JSON answer whose shape the schema rejects, rather than casting it', async () => {
    const client = clientOf(async () => respond('{"items":"nope"}'));
    const result = await client.json(
      'https://example.test/search',
      z.object({ items: z.array(z.string()) }),
    );
    expect(result.ok).toBe(false);
  });

  it('fails on malformed JSON', async () => {
    const client = clientOf(async () => respond('{ not json'));
    const result = await client.json('https://example.test/search', z.object({}));
    expect(result.ok).toBe(false);
  });

  it('reports a non-2xx status as a failure carrying the code', async () => {
    const client = clientOf(async () => respond('', { status: 404 }));
    const result = await client.text('https://example.test/missing');
    expect(result).toEqual({ ok: false, message: 'https://example.test/missing: HTTP 404' });
  });

  it('sends the User-Agent and merges per-call headers', async () => {
    const fetch = vi.fn(async (_url: string, _init?: FetchInit) => respond('{}'));
    await clientOf(fetch).json('https://example.test/x', z.object({}), {
      headers: { Authorization: 'Bearer k' },
    });
    expect(fetch.mock.calls[0]?.[1]?.headers).toEqual({
      'User-Agent': 'Playhook/test',
      Authorization: 'Bearer k',
    });
  });

  it('normalizes the content type, dropping its parameters', async () => {
    const client = clientOf(async () =>
      respond('x', { contentType: 'IMAGE/JPEG; charset=binary' }),
    );
    const result = await client.bytes('https://example.test/a.jpg', 1024);
    expect(result.ok === true && result.value.contentType).toBe('image/jpeg');
  });

  it('refuses a body that grows past the cap, mid-stream', async () => {
    const chunk = new Uint8Array(64);
    const client = clientOf(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: bodyOf([chunk, chunk, chunk]),
    }));
    const result = await client.bytes('https://example.test/big.bin', 100);
    expect(result).toEqual({
      ok: false,
      message: 'https://example.test/big.bin: larger than 100 bytes',
    });
  });

  it('joins the streamed chunks in order', async () => {
    const client = clientOf(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: bodyOf([new Uint8Array([1, 2]), new Uint8Array([3]), new Uint8Array([4, 5])]),
    }));
    const result = await client.bytes('https://example.test/a.bin', 1024);
    expect(result.ok === true && [...result.value.bytes]).toEqual([1, 2, 3, 4, 5]);
  });

  it('gives up immediately when the caller has already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const client = clientOf(async (_url, init) => {
      if (init?.signal?.aborted === true) throw new Error('aborted');
      return respond('{}');
    });
    const result = await client.text('https://example.test/x', { signal: controller.signal });
    expect(result.ok).toBe(false);
  });

  it('answers exists() from the status of a HEAD request', async () => {
    const fetch = vi.fn(async (_url: string, init?: FetchInit) =>
      init?.method === 'HEAD' ? respond('', { status: 200 }) : respond('', { status: 500 }),
    );
    await expect(clientOf(fetch).exists('https://example.test/art.jpg')).resolves.toBe(true);
    expect(fetch.mock.calls[0]?.[1]?.method).toBe('HEAD');
  });

  it('treats a throwing HEAD as "not there" rather than an error', async () => {
    const client = clientOf(async () => {
      throw new Error('offline');
    });
    await expect(client.exists('https://example.test/art.jpg')).resolves.toBe(false);
  });

  describe('where it will and will not go', () => {
    it('refuses a non-https URL without asking fetch at all', async () => {
      const fetch = vi.fn(async () => respond('{}'));
      const result = await clientOf(fetch).bytes('http://example.test/a.jpg', 1024);
      expect(result.ok).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
    });

    it('refuses a private or loopback host — a scraped URL must not reach the LAN', async () => {
      const fetch = vi.fn(async () => respond('{}'));
      const client = clientOf(fetch);
      for (const url of [
        'https://127.0.0.1/a.jpg',
        'https://localhost/a.jpg',
        'https://10.0.0.5/a.jpg',
        'https://192.168.1.1/a.jpg',
        'https://172.16.4.4/a.jpg',
        'https://169.254.169.254/latest/meta-data',
        'https://[::1]/a.jpg',
      ]) {
        expect((await client.bytes(url, 1024)).ok, url).toBe(false);
      }
      expect(fetch).not.toHaveBeenCalled();
    });

    it('refuses on a declared size over the cap, before reading the body', async () => {
      const read = vi.fn(async () => ({ done: true }));
      const client = clientOf(async () => ({
        ok: true,
        status: 200,
        headers: {
          get: (name: string) => (name.toLowerCase() === 'content-length' ? '999' : null),
        },
        body: { getReader: () => ({ read, cancel: async () => undefined }) },
      }));
      const result = await client.bytes('https://example.test/big.bin', 100);
      expect(result.ok).toBe(false);
      expect(read).not.toHaveBeenCalled();
    });

    it('still downloads when the declared size fits the cap', async () => {
      const client = clientOf(async () => ({
        ok: true,
        status: 200,
        headers: { get: (name: string) => (name.toLowerCase() === 'content-length' ? '2' : null) },
        body: bodyOf([new Uint8Array([7, 8])]),
      }));
      const result = await client.bytes('https://example.test/a.bin', 100);
      expect(result.ok === true && [...result.value.bytes]).toEqual([7, 8]);
    });
  });

  describe('the timeouts', () => {
    it('abandons a host that never answers with headers', async () => {
      vi.useFakeTimers();
      try {
        const client = clientOf(
          (_url, init) =>
            new Promise<FetchResponse>((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
            }),
        );
        const pending = client.bytes('https://example.test/slow.bin', 1024);
        await vi.advanceTimersByTimeAsync(10_000);
        expect((await pending).ok).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('abandons a body that stalls between chunks', async () => {
      vi.useFakeTimers();
      try {
        let stalled: (() => void) | null = null;
        const client = clientOf(async (_url, init) => ({
          ok: true,
          status: 200,
          headers: { get: () => null },
          body: {
            getReader: () => ({
              read: async (): Promise<{ done: boolean; value?: Uint8Array }> => {
                // The first chunk arrives; the second never does, and the idle timer has to notice.
                if (stalled === null) {
                  return await new Promise((resolve) => {
                    stalled = () => resolve({ done: false, value: new Uint8Array([1]) });
                    stalled();
                  });
                }
                return await new Promise((_resolve, reject) => {
                  init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
                });
              },
              cancel: async () => undefined,
            }),
          },
        }));
        const pending = client.bytes('https://example.test/stall.bin', 1024);
        await vi.advanceTimersByTimeAsync(30_000);
        expect((await pending).ok).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("stops mid-body when the caller's own signal fires", async () => {
      const controller = new AbortController();
      let reading: (() => void) | null = null;
      const started = (): boolean => reading !== null;
      const client = clientOf(async (_url, init) => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        body: {
          getReader: () => ({
            read: async (): Promise<{ done: boolean; value?: Uint8Array }> =>
              await new Promise((_resolve, reject) => {
                // The signal handed to the body is the client's OWN, mirrored from the caller's.
                const fail = (): void => reject(new Error('aborted'));
                init?.signal?.addEventListener('abort', fail);
                reading = fail;
              }),
            cancel: async () => undefined,
          }),
        },
      }));
      const pending = client.bytes('https://example.test/a.bin', 1024, {
        signal: controller.signal,
      });
      // Let the fetch resolve and the first read start — the abort has to land ON a read in flight.
      while (!started()) await Promise.resolve();
      controller.abort();
      expect((await pending).ok).toBe(false);
    });
  });
});
