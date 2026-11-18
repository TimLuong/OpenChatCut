// Whisper invents text where there is no speech: channel outros learned from
// subtitled YouTube videos ("Hãy subscribe cho kênh Ghiền Mì Gõ…", "Subtitles
// by the Amara.org community"), and loops that repeat one phrase until the
// window ends. Both engines (whisper.cpp on desktop, ONNX in the browser) do
// it, most often over silence, music beds and room tone.
//
// This pass runs on the word chunks either engine returns, before they become
// a transcript, and removes three kinds of fabricated text:
//   1. known credit/outro phrases that real footage practically never says;
//   2. a phrase repeated back-to-back far more often than people speak;
//   3. runs of words whose audio window is near-silent (browser path only,
//      where the decoded samples are already in memory).
// Pure and synchronous so it can be checked without a model.
import type { AsrChunk, AsrResult } from './local-asr-types';

/** Normalized (lowercase, NFC, no punctuation, single spaces) phrases that
 *  Whisper emits from training-data credits rather than from the audio. */
export const HALLUCINATION_PHRASES: readonly string[] = [
  // Vietnamese
  'hãy subscribe cho kênh ghiền mì gõ để không bỏ lỡ những video hấp dẫn',
  'hãy subscribe cho kênh ghiền mì gõ',
  'ghiền mì gõ',
  'hãy đăng ký kênh để ủng hộ kênh của mình nhé',
  'đăng ký kênh để không bỏ lỡ những video hấp dẫn',
  'cảm ơn các bạn đã theo dõi và hẹn gặp lại',
  'hẹn gặp lại các bạn trong những video tiếp theo',
  'la la school',
  // English
  'subtitles by the amaraorg community',
  'transcribed by esoterica',
  'thanks for watching',
  'thank you for watching',
  'please subscribe to my channel',
  // Chinese
  '请不吝点赞 订阅 转发 打赏支持明镜与点点栏目',
  '字幕由amaraorg社区提供',
  '谢谢观看',
];

/** Phrases above that are only dropped when their audio is near-silent: people
 *  do say "thanks for watching" or "cảm ơn các bạn đã theo dõi" for real. */
const SPOKEN_OUTROS: ReadonlySet<string> = new Set([
  'cảm ơn các bạn đã theo dõi và hẹn gặp lại',
  'hẹn gặp lại các bạn trong những video tiếp theo',
  'thanks for watching',
  'thank you for watching',
  '谢谢观看',
]);

export interface HallucinationFilterOptions {
  /** Mono PCM of the transcribed audio, when the caller has it. */
  readonly samples?: Float32Array;
  readonly sampleRate?: number;
}

export interface HallucinationFilterResult {
  readonly result: AsrResult;
  /** How many word chunks were removed, by reason. */
  readonly removed: { readonly phrase: number; readonly repetition: number; readonly silence: number };
}

// Runs at least this long of near-silent words are treated as invented. A
// single quiet word (a whisper, a trailing syllable) is left alone.
const MIN_SILENT_RUN = 3;
const ABSOLUTE_SILENCE_RMS = 0.002;
const RELATIVE_SILENCE = 0.08;
// Back-to-back repeats: people say "không không không", not the same
// four-word phrase five times in a row.
const MAX_NGRAM = 8;
const MIN_PHRASE_REPEATS = 4;
const MIN_WORD_REPEATS = 6;

export function normalizeAsrText(text: string): string {
  return text
    .normalize('NFC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function windowRms(samples: Float32Array, sampleRate: number, startMs: number, endMs: number): number {
  const from = Math.max(0, Math.floor((startMs / 1000) * sampleRate));
  const to = Math.min(samples.length, Math.max(from + 1, Math.ceil((endMs / 1000) * sampleRate)));
  if (to <= from) return 0;
  let sum = 0;
  for (let index = from; index < to; index += 1) sum += samples[index]! * samples[index]!;
  return Math.sqrt(sum / (to - from));
}

function silentFlags(chunks: readonly AsrChunk[], options: HallucinationFilterOptions): boolean[] {
  const { samples } = options;
  if (!samples || samples.length === 0 || chunks.length === 0) return chunks.map(() => false);
  const sampleRate = options.sampleRate ?? 16_000;
  const levels = chunks.map((chunk) => windowRms(samples, sampleRate, chunk.start, chunk.end));
  const sorted = [...levels].sort((left, right) => left - right);
  const speechLevel = sorted[Math.floor(sorted.length * 0.75)] ?? 0;
  const threshold = Math.max(ABSOLUTE_SILENCE_RMS, speechLevel * RELATIVE_SILENCE);
  const quiet = levels.map((level) => level < threshold);
  const flags = chunks.map(() => false);
  let runStart = -1;
  for (let index = 0; index <= quiet.length; index += 1) {
    if (index < quiet.length && quiet[index]) {
      if (runStart < 0) runStart = index;
      continue;
    }
    if (runStart >= 0 && index - runStart >= MIN_SILENT_RUN) {
      for (let cursor = runStart; cursor < index; cursor += 1) flags[cursor] = true;
    }
    runStart = -1;
  }
  return flags;
}

/** Mark chunks that spell out a known hallucinated phrase. Chunk boundaries
 *  differ between engines (whole words vs. CJK characters), so matching runs
 *  on the joined text and maps character ranges back to chunks. */
function phraseFlags(chunks: readonly AsrChunk[], silent: readonly boolean[], hasAudio: boolean): boolean[] {
  const flags = chunks.map(() => false);
  const owners: number[] = [];
  let joined = '';
  chunks.forEach((chunk, index) => {
    const word = normalizeAsrText(chunk.text);
    if (!word) return;
    if (joined) { joined += ' '; owners.push(-1); }
    joined += word;
    for (let count = 0; count < word.length; count += 1) owners.push(index);
  });
  const compact = joined.replace(/ /g, '');
  const compactOwners = owners.filter((_, position) => joined[position] !== ' ');
  for (const phrase of HALLUCINATION_PHRASES) {
    const needle = phrase.replace(/ /g, '');
    if (!needle) continue;
    let from = compact.indexOf(needle);
    while (from >= 0) {
      const covered = new Set(compactOwners.slice(from, from + needle.length));
      const indices = [...covered];
      const mostlySilent = indices.filter((index) => silent[index]).length * 2 >= indices.length;
      if (!SPOKEN_OUTROS.has(phrase) || (hasAudio && mostlySilent)) {
        for (const index of indices) flags[index] = true;
      }
      from = compact.indexOf(needle, from + needle.length);
    }
  }
  // Punctuation-only chunks ("." inside "Amara.org") have no normalized text
  // and so no owner; drop them when the words on both sides were dropped.
  const blank = chunks.map((chunk) => normalizeAsrText(chunk.text) === '');
  for (let index = 0; index < chunks.length; index += 1) {
    if (!blank[index]) continue;
    let before = index - 1;
    while (before >= 0 && blank[before]) before -= 1;
    let after = index + 1;
    while (after < chunks.length && blank[after]) after += 1;
    const leftDropped = before < 0 || flags[before];
    const rightDropped = after >= chunks.length || flags[after];
    if (leftDropped && rightDropped && (before >= 0 || after < chunks.length)) flags[index] = true;
  }
  return flags;
}

/** Mark every repeat after the first of an n-gram that loops back-to-back. */
function repetitionFlags(chunks: readonly AsrChunk[]): boolean[] {
  const words = chunks.map((chunk) => normalizeAsrText(chunk.text));
  const flags = chunks.map(() => false);
  let index = 0;
  while (index < words.length) {
    let advanced = false;
    for (let size = MAX_NGRAM; size >= 1 && !advanced; size -= 1) {
      if (index + size * 2 > words.length) continue;
      const gram = words.slice(index, index + size).join(' ');
      if (!gram) continue;
      let repeats = 1;
      while (words.slice(index + repeats * size, index + (repeats + 1) * size).join(' ') === gram) repeats += 1;
      const limit = size === 1 ? MIN_WORD_REPEATS : MIN_PHRASE_REPEATS;
      if (repeats >= limit) {
        for (let cursor = index + size; cursor < index + repeats * size; cursor += 1) flags[cursor] = true;
        index += repeats * size;
        advanced = true;
      }
    }
    if (!advanced) index += 1;
  }
  return flags;
}

export function filterAsrHallucinations(
  input: AsrResult,
  options: HallucinationFilterOptions = {},
): HallucinationFilterResult {
  const chunks = input.chunks;
  if (chunks.length === 0) return { result: input, removed: { phrase: 0, repetition: 0, silence: 0 } };
  const hasAudio = Boolean(options.samples && options.samples.length > 0);
  const silent = silentFlags(chunks, options);
  const phrase = phraseFlags(chunks, silent, hasAudio);
  const repetition = repetitionFlags(chunks);
  const removed = { phrase: 0, repetition: 0, silence: 0 };
  const kept: AsrChunk[] = [];
  chunks.forEach((chunk, index) => {
    if (phrase[index]) removed.phrase += 1;
    else if (repetition[index]) removed.repetition += 1;
    else if (silent[index]) removed.silence += 1;
    else kept.push(chunk);
  });
  if (kept.length === chunks.length) return { result: input, removed };
  // The engine's own text no longer matches the kept words; rebuild it from
  // them so the transcript and its word timings stay consistent.
  return { result: { text: joinWords(kept.map((chunk) => chunk.text)), chunks: kept }, removed };
}

// Scripts written without spaces between words (see desktop/native-asr-utils).
const UNSPACED = /[぀-ヿ㐀-鿿豈-﫿฀-໿က-႟]/u;

/** Join word chunks with spaces, except between two unspaced-script words. */
export function joinWords(words: readonly string[]): string {
  let out = '';
  for (const word of words) {
    if (!word) continue;
    const glue = out && !(UNSPACED.test(out.at(-1)!) && UNSPACED.test(word[0]!)) ? ' ' : '';
    out += glue + word;
  }
  return out;
}
