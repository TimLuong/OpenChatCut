// npx tsx src/transcript/hallucination-filter.verify.ts
import assert from 'node:assert/strict';
import { filterAsrHallucinations, joinWords } from './hallucination-filter';
import type { AsrChunk } from './local-asr-types';

const SR = 16_000;

function words(text: string, startMs = 0, stepMs = 300): AsrChunk[] {
  return text.split(' ').map((word, index) => ({
    text: word,
    start: startMs + index * stepMs,
    end: startMs + (index + 1) * stepMs,
  }));
}

/** Tone where `voiced(ms)` is true, digital silence elsewhere. */
function audio(totalMs: number, voiced: (ms: number) => boolean): Float32Array {
  const samples = new Float32Array(Math.ceil((totalMs / 1000) * SR));
  for (let index = 0; index < samples.length; index += 1) {
    const ms = (index / SR) * 1000;
    if (voiced(ms)) samples[index] = 0.2 * Math.sin((2 * Math.PI * 220 * index) / SR);
  }
  return samples;
}

// 1. The classic Vietnamese credit hallucination is removed even without audio.
{
  const chunks = [
    ...words('Xin chào mọi người hôm nay mình nấu phở'),
    ...words('Hãy subscribe cho kênh Ghiền Mì Gõ Để không bỏ lỡ những video hấp dẫn', 3000),
  ];
  const { result, removed } = filterAsrHallucinations({ text: 'ignored', chunks });
  assert.equal(result.text, 'Xin chào mọi người hôm nay mình nấu phở');
  assert.equal(removed.phrase, 15);
}

// 2. Real speech is untouched, and the engine text is kept when nothing is removed.
{
  const chunks = words('Hôm nay trời đẹp quá các bạn ạ');
  const input = { text: 'Hôm nay trời đẹp quá các bạn ạ.', chunks };
  const { result, removed } = filterAsrHallucinations(input, { samples: audio(3000, () => true), sampleRate: SR });
  assert.equal(result, input, 'unchanged results are returned as-is');
  assert.deepEqual(removed, { phrase: 0, repetition: 0, silence: 0 });
}

// 3. A spoken outro survives when there is audio under it, and goes when the audio is silent.
{
  const chunks = [...words('món này ngon lắm'), ...words('cảm ơn các bạn đã theo dõi và hẹn gặp lại', 1200)];
  const spoken = filterAsrHallucinations({ text: '', chunks }, { samples: audio(5000, () => true), sampleRate: SR });
  assert.equal(spoken.removed.phrase, 0, 'a voiced outro is real speech');
  const silentTail = filterAsrHallucinations({ text: '', chunks }, { samples: audio(5000, (ms) => ms < 1200), sampleRate: SR });
  assert.equal(silentTail.result.text, 'món này ngon lắm');
  assert.ok(silentTail.removed.phrase + silentTail.removed.silence === 11);
}

// 4. Repetition loops collapse to one occurrence; ordinary emphasis does not.
{
  const loop = words('cái này là cái này là cái này là cái này là cái này là');
  assert.equal(filterAsrHallucinations({ text: '', chunks: loop }).result.text, 'cái này là');
  const emphasis = words('không không không được đâu');
  assert.equal(filterAsrHallucinations({ text: '', chunks: emphasis }).removed.repetition, 0);
}

// 5. Near-silent runs of three or more words are dropped; a single quiet word is kept.
{
  const chunks = [...words('một hai ba'), ...words('bốn năm sáu bảy', 900), ...words('tám', 2100)];
  const samples = audio(2400, (ms) => ms < 900 || ms >= 2100);
  const { result, removed } = filterAsrHallucinations({ text: '', chunks }, { samples, sampleRate: SR });
  assert.equal(result.text, 'một hai ba tám');
  assert.equal(removed.silence, 4);
  const oneQuiet = [...words('một hai'), ...words('ba', 600), ...words('bốn', 900)];
  const quietSamples = audio(1200, (ms) => ms < 600 || ms >= 900);
  assert.equal(filterAsrHallucinations({ text: '', chunks: oneQuiet }, { samples: quietSamples, sampleRate: SR }).removed.silence, 0);
}

// 6. CJK credit lines are matched across per-character chunks.
{
  const chunks = [...'今天天气很好'].map((ch, i) => ({ text: ch, start: i * 200, end: i * 200 + 200 }))
    .concat([...'字幕由Amara.org社区提供'].map((ch, i) => ({ text: ch, start: 2000 + i * 100, end: 2100 + i * 100 })));
  assert.equal(filterAsrHallucinations({ text: '', chunks }).result.text, '今天天气很好');
}

// 7. Word joining keeps spaces for spaced scripts and none between CJK characters.
assert.equal(joinWords(['Xin', 'chào', '你', '好', 'OK']), 'Xin chào 你好 OK');

console.log('hallucination-filter.verify: credit phrases, loops and silent runs are removed; real speech is kept');
