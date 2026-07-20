// Binary VDF (Valve's key-value binary format) reader/writer, scoped to what `shortcuts.vdf` uses.
// Pure and electron-free (unit-tested in test/steam-shortcuts-vdf.test.ts).
//
// Why hand-rolled and not a dependency: the plan's candidate `steam-binary-vdf` is a single 0.1.0 release
// over a year old that drags in six transitive deps (hex2dec, polycrc, buffer-reader, node-int64) — it
// failed both liveness and dependency checks, so the plan's explicit fallback applies. The format is small
// and frozen; a round-trip test covers it far more cheaply than auditing that tree.
//
// Format: a stream of `<type byte><key NUL><payload>` entries, terminated by 0x08.
//   0x00 map     — payload is a nested entry stream, itself terminated by 0x08
//   0x01 string  — payload is a NUL-terminated UTF-8 string
//   0x02 int32   — payload is 4 bytes, little-endian, SIGNED (shortcut appids are negative)
//   0x08 end-of-map
// shortcuts.vdf is one root map named `shortcuts` whose keys are stringified indices ("0", "1", …); the
// file therefore ends with two 0x08 (end of root map, end of stream).
//
// Anything outside that type set is REFUSED rather than guessed at: this parses live user data whose
// corruption would cost them every non-Steam shortcut they have.

const TYPE_MAP = 0x00;
const TYPE_STRING = 0x01;
const TYPE_INT32 = 0x02;
const TYPE_END = 0x08;

export type VdfValue = string | number | VdfMap;

/** A binary-VDF map. Key order is significant on write and is preserved by insertion order. */
export interface VdfMap {
  readonly [key: string]: VdfValue;
}

/** Untrusted on-disk data → Result-union (CLAUDE.md error-handling convention). */
export type VdfParseResult =
  { readonly ok: true; readonly value: VdfMap } | { readonly ok: false; readonly message: string };

/** Reads a NUL-terminated UTF-8 string; returns the value and the offset just past the terminator. */
function readCString(
  buf: Buffer,
  offset: number,
): { readonly value: string; readonly next: number } | null {
  const end = buf.indexOf(0, offset);
  if (end === -1) return null;
  return { value: buf.toString('utf8', offset, end), next: end + 1 };
}

/** Reads one map's entries starting at `offset`, stopping after its 0x08 terminator. */
function readMap(
  buf: Buffer,
  offset: number,
): { readonly value: VdfMap; readonly next: number } | { readonly error: string } {
  const entries: Record<string, VdfValue> = {};
  let cursor = offset;
  for (;;) {
    if (cursor >= buf.length) return { error: 'unexpected end of file (unterminated map)' };
    const type = buf[cursor];
    cursor += 1;
    if (type === TYPE_END) return { value: entries, next: cursor };

    const key = readCString(buf, cursor);
    if (key === null) return { error: `unterminated key at offset ${cursor}` };
    cursor = key.next;

    if (type === TYPE_MAP) {
      const nested = readMap(buf, cursor);
      if ('error' in nested) return nested;
      entries[key.value] = nested.value;
      cursor = nested.next;
      continue;
    }
    if (type === TYPE_STRING) {
      const value = readCString(buf, cursor);
      if (value === null) return { error: `unterminated string for key "${key.value}"` };
      entries[key.value] = value.value;
      cursor = value.next;
      continue;
    }
    if (type === TYPE_INT32) {
      if (cursor + 4 > buf.length) return { error: `truncated int32 for key "${key.value}"` };
      entries[key.value] = buf.readInt32LE(cursor);
      cursor += 4;
      continue;
    }
    return { error: `unsupported value type 0x${(type ?? 0).toString(16)} for key "${key.value}"` };
  }
}

/** Parses a whole binary VDF buffer into its root map. */
export function parseBinaryVdf(buf: Buffer): VdfParseResult {
  const root = readMap(buf, 0);
  if ('error' in root) return { ok: false, message: root.error };
  // The root map holds exactly one entry (`shortcuts`); anything else is not a file we should rewrite.
  const keys = Object.keys(root.value);
  if (keys.length !== 1) {
    return { ok: false, message: `expected a single root key, got ${keys.length}` };
  }
  return { ok: true, value: root.value };
}

function serializeMap(map: VdfMap): Buffer {
  const chunks: Buffer[] = [];
  for (const [key, value] of Object.entries(map)) {
    const keyBuf = Buffer.concat([Buffer.from(key, 'utf8'), Buffer.from([0])]);
    if (typeof value === 'string') {
      chunks.push(Buffer.from([TYPE_STRING]), keyBuf, Buffer.from(value, 'utf8'), Buffer.from([0]));
      continue;
    }
    if (typeof value === 'number') {
      const payload = Buffer.alloc(4);
      // `| 0` keeps an unsigned-looking appid (e.g. 3407509860) writing as the signed int32 Steam stores.
      payload.writeInt32LE(value | 0, 0);
      chunks.push(Buffer.from([TYPE_INT32]), keyBuf, payload);
      continue;
    }
    chunks.push(Buffer.from([TYPE_MAP]), keyBuf, serializeMap(value));
  }
  chunks.push(Buffer.from([TYPE_END]));
  return Buffer.concat(chunks);
}

/** Serializes a root map back to binary VDF (byte-identical round-trip for files we can parse). */
export function serializeBinaryVdf(root: VdfMap): Buffer {
  return serializeMap(root);
}

// ── The shortcuts.vdf view: a flat, ordered list of records ──────────────────
// The on-disk keys are positional indices, so callers should never have to maintain them by hand — a
// removal from the middle would otherwise leave a hole. Parse to a list, edit the list, serialize back
// with indices renumbered from 0.

/** One shortcut record (`AppName`, `Exe`, `appid`, …). Field names keep Steam's own casing. */
export type ShortcutRecord = VdfMap;

export type ShortcutsParseResult =
  | { readonly ok: true; readonly records: readonly ShortcutRecord[]; readonly rootKey: string }
  | { readonly ok: false; readonly message: string };

/** The root key Steam writes. Preserved from the parsed file when rewriting, used as-is for a new file. */
export const SHORTCUTS_ROOT_KEY = 'shortcuts';

/** Parses `shortcuts.vdf` content into its records, in file order. */
export function parseShortcuts(buf: Buffer): ShortcutsParseResult {
  const parsed = parseBinaryVdf(buf);
  if (!parsed.ok) return { ok: false, message: parsed.message };
  const rootKey = Object.keys(parsed.value)[0];
  if (rootKey === undefined) return { ok: false, message: 'empty root map' };
  const container = parsed.value[rootKey];
  if (typeof container !== 'object') {
    return { ok: false, message: `root key "${rootKey}" is not a map` };
  }
  const records: ShortcutRecord[] = [];
  for (const [index, value] of Object.entries(container)) {
    if (typeof value !== 'object') {
      return { ok: false, message: `shortcut entry "${index}" is not a map` };
    }
    records.push(value);
  }
  return { ok: true, records, rootKey };
}

/** Serializes records back to `shortcuts.vdf` bytes, renumbering the positional keys from 0. */
export function serializeShortcuts(
  records: readonly ShortcutRecord[],
  rootKey: string = SHORTCUTS_ROOT_KEY,
): Buffer {
  const container: Record<string, VdfValue> = {};
  records.forEach((record, index) => {
    container[String(index)] = record;
  });
  return serializeBinaryVdf({ [rootKey]: container });
}
