// What a downloaded file actually IS, decided from its own bytes.
//
// Everything else about a download is a claim by a stranger: the URL's extension, the Content-Type
// header, the name the source gave it. None of them is checked by anyone, and all of them end up naming
// a file inside the user's card or library — so the last word belongs to the magic bytes. A body that
// sniffs as nothing recognizable is refused rather than written under a guessed extension.
//
// Pure and dependency-free, so the table is unit-tested rather than exercised through a download.

/** Which family a sniffed file belongs to — the same two the manifest's asset fields distinguish. */
export type MediaKind = 'image' | 'audio';

export interface SniffedMedia {
  readonly kind: MediaKind;
  /** The canonical extension WITHOUT its dot, matching IMAGE_EXTENSIONS / AUDIO_EXTENSIONS. */
  readonly extension: string;
}

/** One signature: bytes that must match at `offset`, and what they mean. */
interface Signature {
  readonly offset: number;
  readonly bytes: readonly number[];
  readonly kind: MediaKind;
  readonly extension: string;
  /** A second marker further in — RIFF and ISO-BMFF containers hold more than one format. */
  readonly also?: { readonly offset: number; readonly bytes: readonly number[] };
}

const ASCII = (text: string): readonly number[] => [...text].map((char) => char.charCodeAt(0));

const SIGNATURES: readonly Signature[] = [
  { offset: 0, bytes: [0xff, 0xd8, 0xff], kind: 'image', extension: 'jpg' },
  {
    offset: 0,
    bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    kind: 'image',
    extension: 'png',
  },
  { offset: 0, bytes: ASCII('GIF8'), kind: 'image', extension: 'gif' },
  {
    offset: 0,
    bytes: ASCII('RIFF'),
    kind: 'image',
    extension: 'webp',
    also: { offset: 8, bytes: ASCII('WEBP') },
  },
  {
    offset: 0,
    bytes: ASCII('RIFF'),
    kind: 'audio',
    extension: 'wav',
    also: { offset: 8, bytes: ASCII('WAVE') },
  },
  { offset: 0, bytes: ASCII('OggS'), kind: 'audio', extension: 'ogg' },
  { offset: 0, bytes: ASCII('fLaC'), kind: 'audio', extension: 'flac' },
  { offset: 0, bytes: ASCII('ID3'), kind: 'audio', extension: 'mp3' },
  { offset: 4, bytes: ASCII('ftyp'), kind: 'audio', extension: 'm4a' },
];

function matches(bytes: Uint8Array, signature: Signature): boolean {
  const at = (offset: number, expected: readonly number[]): boolean =>
    expected.every((byte, index) => bytes[offset + index] === byte);
  if (!at(signature.offset, signature.bytes)) return false;
  return signature.also === undefined || at(signature.also.offset, signature.also.bytes);
}

/**
 * An MPEG audio frame — an mp3 with no ID3 tag at all, which is common for a ripped soundtrack track.
 * The sync word is eleven set bits, and the two bits after it must name a real MPEG version and layer
 * (`01` is reserved in both), which is what keeps this from matching arbitrary binary noise.
 */
function isMpegFrame(bytes: Uint8Array): boolean {
  const first = bytes[0];
  const second = bytes[1];
  if (first !== 0xff || second === undefined) return false;
  if ((second & 0xe0) !== 0xe0) return false;
  const version = (second & 0x18) >> 3;
  const layer = (second & 0x06) >> 1;
  return version !== 1 && layer !== 0;
}

/** What these bytes are, or null when nothing recognizable — in which case nothing gets written. */
export function sniffMedia(bytes: Uint8Array): SniffedMedia | null {
  for (const signature of SIGNATURES) {
    if (matches(bytes, signature)) return { kind: signature.kind, extension: signature.extension };
  }
  return isMpegFrame(bytes) ? { kind: 'audio', extension: 'mp3' } : null;
}
