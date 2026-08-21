// The one place the app talks HTTP to the outside world (electron-updater aside). Everything the
// metadata providers fetch — JSON from Steam, HTML from Khinsider, image and audio bytes from a CDN —
// goes through this client, so the limits that make an untrusted download safe are stated ONCE:
//
//   * a byte cap, enforced WHILE the body streams (a `Content-Length` from a stranger proves nothing);
//   * a header timeout, so a dead host fails fast;
//   * an IDLE timeout on the body rather than a total one — a hero image or a soundtrack track over the
//     Deck's Wi-Fi legitimately takes a minute, and a total deadline would kill exactly those;
//   * an AbortSignal on every call, because the user can leave the screen mid-download (Back).
//
// Failures are Result-unions, never throws: an offline host, a 404 for a game Steam never had art for,
// a rate limit — all of these are NORMAL outcomes of this module, and the caller must handle them
// explicitly (the untrusted-external-data convention in CLAUDE.md).
//
// `fetch` arrives through deps: the unit tests hand it a fake, so no test ever touches the network.
// Known limitation: the global (undici) fetch ignores the system proxy, unlike electron's net.fetch —
// accepted deliberately, the module stays electron-free and importable from a plain-Node test.
import { z } from 'zod';
import { type MetadataResult } from '../../shared/types';
import { describe } from '../util';

/** How long a host has to answer with STATUS AND HEADERS before the request is abandoned. */
const HEADER_TIMEOUT_MS = 10_000;
/** How long the body may stall BETWEEN chunks. Resets on every chunk, so a slow-but-alive download lives. */
const BODY_IDLE_TIMEOUT_MS = 30_000;
/** Cap for the text/JSON calls (an API answer or one HTML page; art and audio pass their own). */
const MAX_TEXT_BYTES = 4 * 1024 * 1024;

/**
 * The subset of `fetch` this module uses, declared structurally rather than imported: the main-process
 * tsconfig has no DOM lib (its `Response` comes from undici's types) while the shared program does, and
 * a hand-written shape is assignable from both — and trivially faked in a test.
 */
export type FetchLike = (url: string, init?: FetchInit) => Promise<FetchResponse>;

export interface FetchInit {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly signal?: AbortSignal;
}

export interface FetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  readonly body: FetchBody | null;
}

export interface FetchBody {
  getReader(): FetchBodyReader;
}

export interface FetchBodyReader {
  read(): Promise<{ readonly done: boolean; readonly value?: Uint8Array }>;
  cancel(): Promise<void>;
}

export interface HttpDeps {
  readonly fetch: FetchLike;
  /** Identifies the app to the sources it queries: `Playhook/<version>`. */
  readonly userAgent: string;
}

/** Per-call knobs. `headers` carries a provider's auth (SteamGridDB's bearer key), `signal` the user's Back. */
export interface HttpOptions {
  readonly headers?: Record<string, string>;
  readonly signal?: AbortSignal;
}

/** A downloaded body plus the one header the caller needs to name the file it writes. */
export interface HttpBytes {
  readonly bytes: Uint8Array;
  /** Lower-cased, parameters stripped (`image/jpeg`), or undefined when the source did not say. */
  readonly contentType?: string;
}

export class HttpClient {
  constructor(private readonly deps: HttpDeps) {}

  /** Fetches a body and validates it against `schema`; a malformed answer is a failure, not a cast. */
  async json<T>(
    url: string,
    schema: z.ZodType<T>,
    options?: HttpOptions,
  ): Promise<MetadataResult<T>> {
    const text = await this.text(url, options);
    if (!text.ok) return text;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.value);
    } catch (cause) {
      return { ok: false, message: `${url}: malformed JSON (${describe(cause)})` };
    }
    const validated = schema.safeParse(parsed);
    if (!validated.success) {
      return { ok: false, message: `${url}: unexpected response shape` };
    }
    return { ok: true, value: validated.data };
  }

  /** Fetches a body as UTF-8 text, capped at MAX_TEXT_BYTES (an API answer, or one scraped page). */
  async text(url: string, options?: HttpOptions): Promise<MetadataResult<string>> {
    const result = await this.bytes(url, MAX_TEXT_BYTES, options);
    if (!result.ok) return result;
    return { ok: true, value: new TextDecoder().decode(result.value.bytes) };
  }

  /**
   * Downloads up to `maxBytes` of a body. The cap is enforced chunk by chunk and the read is aborted the
   * moment it is exceeded — nothing oversized is ever held whole in memory, let alone written to disk.
   */
  async bytes(
    url: string,
    maxBytes: number,
    options?: HttpOptions,
  ): Promise<MetadataResult<HttpBytes>> {
    const controller = new AbortController();
    const unlink = linkAbort(options?.signal, controller);
    let headerTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(
      () => controller.abort(),
      HEADER_TIMEOUT_MS,
    );
    try {
      const response = await this.deps.fetch(url, {
        headers: this.headers(options),
        signal: controller.signal,
      });
      clearTimeout(headerTimer);
      headerTimer = undefined;
      if (!response.ok) return { ok: false, message: `${url}: HTTP ${response.status}` };
      const body = response.body;
      if (body === null) return { ok: false, message: `${url}: empty response body` };
      const collected = await readCapped(body, maxBytes, controller);
      if (!collected.ok) return { ok: false, message: `${url}: ${collected.message}` };
      const contentType = normalizeContentType(response.headers.get('content-type'));
      return {
        ok: true,
        value:
          contentType === undefined
            ? { bytes: collected.value }
            : { bytes: collected.value, contentType },
      };
    } catch (cause) {
      return { ok: false, message: `${url}: ${describe(cause)}` };
    } finally {
      if (headerTimer !== undefined) clearTimeout(headerTimer);
      unlink();
    }
  }

  /**
   * Whether a URL actually has something behind it, without downloading it. Steam's CDN answers 404 for
   * art an old game never had, and a gallery must not offer a variant whose apply would then fail.
   */
  async exists(url: string, options?: HttpOptions): Promise<boolean> {
    const controller = new AbortController();
    const unlink = linkAbort(options?.signal, controller);
    const timer = setTimeout(() => controller.abort(), HEADER_TIMEOUT_MS);
    try {
      const response = await this.deps.fetch(url, {
        method: 'HEAD',
        headers: this.headers(options),
        signal: controller.signal,
      });
      await response.body?.getReader().cancel();
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
      unlink();
    }
  }

  private headers(options?: HttpOptions): Record<string, string> {
    return { 'User-Agent': this.deps.userAgent, ...(options?.headers ?? {}) };
  }
}

/** Mirrors an external abort onto the request's own controller; returns the detach function. */
function linkAbort(external: AbortSignal | undefined, controller: AbortController): () => void {
  if (external === undefined) return () => undefined;
  if (external.aborted) {
    controller.abort();
    return () => undefined;
  }
  const onAbort = (): void => controller.abort();
  external.addEventListener('abort', onAbort);
  return () => external.removeEventListener('abort', onAbort);
}

/**
 * Streams a body into one buffer, refusing to grow past `maxBytes` and giving up when the source stops
 * feeding for BODY_IDLE_TIMEOUT_MS. The idle timer is re-armed per chunk — that is the whole difference
 * between "this download is slow" (fine) and "this download is dead" (not).
 */
async function readCapped(
  body: FetchBody,
  maxBytes: number,
  controller: AbortController,
): Promise<MetadataResult<Uint8Array>> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let idleTimer = setTimeout(() => controller.abort(), BODY_IDLE_TIMEOUT_MS);
  try {
    for (;;) {
      const chunk = await reader.read();
      clearTimeout(idleTimer);
      if (chunk.done === true) break;
      const value = chunk.value;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        controller.abort();
        return { ok: false, message: `larger than ${maxBytes} bytes` };
      }
      chunks.push(value);
      idleTimer = setTimeout(() => controller.abort(), BODY_IDLE_TIMEOUT_MS);
    }
  } catch (cause) {
    return { ok: false, message: describe(cause) };
  } finally {
    clearTimeout(idleTimer);
  }
  return { ok: true, value: concat(chunks, total) };
}

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** `image/jpeg; charset=binary` → `image/jpeg`. Undefined when the header is absent or blank. */
function normalizeContentType(raw: string | null): string | undefined {
  if (raw === null) return undefined;
  const value = raw.split(';')[0]?.trim().toLowerCase() ?? '';
  return value.length > 0 ? value : undefined;
}
