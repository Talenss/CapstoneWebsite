/* ResumeMatch PH — lib/file-type.ts

   The Content-Type on a multipart upload is supplied by the CLIENT, so it is
   a claim, not a fact. Trusting it alone meant an arbitrary blob could be
   stored as "<random>.pdf" and later served back under a PDF content type.

   This reads the first few bytes and reports what the file ACTUALLY is. It
   is intentionally small: we only accept five formats, and each has a short,
   well-known signature at a fixed offset. */
import fs from 'fs';

export type SniffedType = 'pdf' | 'doc' | 'docx' | 'jpg' | 'png';

/** Longest signature we need to compare, plus room for the ZIP local header. */
const HEAD_BYTES = 8;

function startsWith(buf: Buffer, bytes: number[]): boolean {
  if (buf.length < bytes.length) return false;
  return bytes.every((b, i) => buf[i] === b);
}

/** Reports what the leading bytes ACTUALLY are, or null when they match none
 *  of the five formats we accept. Takes the bytes rather than a path so an
 *  upload can be checked in memory, before it is written anywhere. */
export function sniffBytes(buf: Buffer): SniffedType | null {
  try {
    if (buf.length < 4) return null;

    // %PDF
    if (startsWith(buf, [0x25, 0x50, 0x44, 0x46])) return 'pdf';
    // JPEG SOI + marker
    if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'jpg';
    // PNG signature
    if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
    // OLE2 compound file — legacy .doc
    if (startsWith(buf, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'doc';
    // ZIP local file header — .docx is a zip. "PK\x03\x04", and the empty and
    // spanned variants a real archive can legitimately start with.
    if (buf[0] === 0x50 && buf[1] === 0x4b
      && ((buf[2] === 0x03 && buf[3] === 0x04)
        || (buf[2] === 0x05 && buf[3] === 0x06)
        || (buf[2] === 0x07 && buf[3] === 0x08))) return 'docx';

    return null;
  } catch {
    return null;
  }
}

/** Path-based convenience wrapper, kept for callers that already hold a file
 *  on disk rather than a buffer. */
export function sniffFileType(filePath: string): SniffedType | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const read = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    return sniffBytes(buf.subarray(0, read));
  } catch {
    return null;
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch { /* already closed */ }
  }
}

/** True when the sniffed format is consistent with the extension the MIME
 *  table produced. .doc and .docx are treated as interchangeable: Word will
 *  happily save either under either content type, and both are only ever
 *  stored and handed back, never executed or parsed for scoring. */
export function typeMatches(sniffed: SniffedType, extFromMime: string): boolean {
  if (sniffed === extFromMime) return true;
  const word = (x: string) => x === 'doc' || x === 'docx';
  return word(sniffed) && word(extFromMime);
}
