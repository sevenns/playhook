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
        if (index >= chunks.length) return { done: true };
        const value = chunks[index]!;
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
    const fetch = vi.fn(async () => respond('{}'));
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
});
