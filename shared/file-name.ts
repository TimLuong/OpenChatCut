// Single source of truth for user-facing file naming, shared by both hosts on
// purpose: the browser decides the name the user sees in the export dialog and
// the server writes that name to disk. Two copies of this rule would drift the
// moment either side gained a character class the other lacked.
const FORBIDDEN_FILE_NAME_CHARS = /[/\\:*?"<>|]+/g;

function replaceControlCharacters(value: string): string {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && codePoint < 32 ? '_' : character;
  }).join('');
}

/** Byte budget for a sanitized name. Most filesystems cap a name at 255 UTF-8
 *  bytes; callers often append an extension or a " (2)" suffix afterwards, and
 *  the export destination rejects names over 240 bytes, so leave headroom.
 *  Vietnamese, Chinese and emoji titles cost 2–4 bytes per character, so a
 *  long project title overflowed long before 255 characters. */
export const MAX_FILE_NAME_BYTES = 200;

const encoder = new TextEncoder();
const byteLength = (value: string): number => encoder.encode(value).length;
// A short alphanumeric tail after the last dot is kept whole when truncating.
const EXTENSION = /(\.[A-Za-z0-9]{1,10})$/;

function graphemes(value: string): string[] {
  const Segmenter = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  if (!Segmenter) return Array.from(value);
  return Array.from(new Segmenter(undefined, { granularity: 'grapheme' }).segment(value), (part) => part.segment);
}

/** Cut `value` to at most `maxBytes` UTF-8 bytes on a grapheme boundary,
 *  keeping a trailing extension such as ".mp4" intact. */
export function limitFileNameBytes(value: string, maxBytes: number = MAX_FILE_NAME_BYTES): string {
  if (byteLength(value) <= maxBytes) return value;
  const extension = EXTENSION.exec(value)?.[1] ?? '';
  const keepExtension = extension && byteLength(extension) < maxBytes ? extension : '';
  const stem = keepExtension ? value.slice(0, -keepExtension.length) : value;
  let budget = maxBytes - byteLength(keepExtension);
  let out = '';
  for (const part of graphemes(stem)) {
    const size = byteLength(part);
    if (size > budget) break;
    out += part;
    budget -= size;
  }
  return out.trimEnd() + keepExtension;
}

/** Preserve Unicode while replacing characters forbidden by common filesystems,
 *  and cap the result at `maxBytes` UTF-8 bytes (pass Infinity to skip). */
export function sanitizeFileName(value: string, fallback: string, maxBytes: number = MAX_FILE_NAME_BYTES): string {
  const cleaned = replaceControlCharacters(value)
    .replace(FORBIDDEN_FILE_NAME_CHARS, '_')
    .trim();
  return (Number.isFinite(maxBytes) ? limitFileNameBytes(cleaned, maxBytes) : cleaned) || fallback;
}
