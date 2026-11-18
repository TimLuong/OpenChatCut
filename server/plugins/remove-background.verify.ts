// Runs the real RVM model over a short synthetic clip and checks the output
// is a transparent VP9 WebM with the same frames, size and audio.
// Needs the RVM model: set RVM_MODEL_PATH, or it is fetched once to the model cache.
// npx tsx server/plugins/remove-background.verify.ts
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ffmpegBin, ffprobeBin } from '../media-binaries.ts';
import {
  downsampleRatio,
  ensureRvmModel,
  mattingArtifactName,
  matteSize,
  planarToRgba,
  removeBackgroundToFile,
  rgb24ToPlanar,
} from './remove-background.ts';

// Pure helpers.
assert.deepEqual(matteSize(3840, 2160), { width: 1920, height: 1080 }, '4K is matted at 1080p');
assert.deepEqual(matteSize(1081, 721), { width: 1082, height: 722 }, 'odd sizes round to even for yuva420p');
assert.equal(downsampleRatio(1920, 1080), 512 / 1920);
assert.equal(downsampleRatio(320, 240), 1, 'small sources are never upsampled');
const planar = rgb24ToPlanar(new Uint8Array([255, 0, 51, 0, 255, 102]), 2);
assert.deepEqual([...planar].map((v) => Math.round(v * 100) / 100), [1, 0, 0, 1, 0.2, 0.4], 'RGB24 becomes planar R,G,B');
assert.deepEqual([...planarToRgba(new Float32Array([1, 0, 0, 1, 0.2, 0.4]), new Float32Array([0, 0.5]), 2)], [255, 0, 51, 0, 0, 255, 102, 128]);
const nameA = mattingArtifactName('Phỏng vấn.mp4', 'rev-1');
assert.ok(nameA.endsWith('.webm') && nameA.includes('rev-1') && nameA.includes('.matte.'));
assert.notEqual(mattingArtifactName('a.mp4', 'rev-1', 'n1'), mattingArtifactName('a.mp4', 'rev-1', 'n2'), 'force gives a fresh artifact');

const run = (bin: string, args: string[]) => {
  const result = spawnSync(bin, args, { encoding: 'utf8' });
  assert.equal(result.status, 0, `${bin} failed: ${result.stderr.slice(-400)}`);
  return result.stdout;
};

const dir = mkdtempSync(join(tmpdir(), 'remove-background-'));
try {
  const source = join(dir, 'clip.mp4');
  run(ffmpegBin(), [
    '-hide_banner', '-nostdin', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=10:d=1',
    '-f', 'lavfi', '-i', 'sine=f=440:d=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', source,
  ]);
  const modelPath = process.env.RVM_MODEL_PATH || await ensureRvmModel();
  const output = join(dir, 'clip.matte.webm');
  let progress = 0;
  const result = await removeBackgroundToFile(source, output, { modelPath, onProgress: (frames) => { progress = frames; } });
  assert.equal(result.frames, 10, 'every source frame is matted');
  assert.equal(progress, 10);
  assert.deepEqual([result.width, result.height], [320, 240]);

  const probe = JSON.parse(run(ffprobeBin(), ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', output]));
  const video = probe.streams.find((s: { codec_type: string }) => s.codec_type === 'video');
  const audio = probe.streams.find((s: { codec_type: string }) => s.codec_type === 'audio');
  assert.equal(video.codec_name, 'vp9');
  assert.equal(video.tags?.alpha_mode ?? video.tags?.ALPHA_MODE, '1', 'the WebM is flagged as carrying alpha');
  assert.equal(audio?.codec_name, 'opus', 'the original audio is carried over');
  assert.ok(Math.abs(Number(probe.format.duration) - 1) < 0.15, `duration stays ~1 s (got ${probe.format.duration})`);

  // Decode with libvpx-vp9 (the decoder that reads the alpha plane) and check
  // the alpha channel is real data, not a constant opaque plane.
  const alpha = spawnSync(ffmpegBin(), [
    '-hide_banner', '-loglevel', 'error', '-c:v', 'libvpx-vp9', '-i', output,
    '-frames:v', '1', '-vf', 'alphaextract,format=gray', '-f', 'rawvideo', 'pipe:1',
  ], { maxBuffer: 16 * 1024 * 1024 });
  assert.equal(alpha.status, 0, String(alpha.stderr));
  const plane = alpha.stdout as Buffer;
  assert.equal(plane.length, 320 * 240, 'one full-size alpha plane');
  console.log(`remove-background.verify: ${result.frames} frames matted to transparent VP9 (alpha min ${Math.min(...plane)}, max ${Math.max(...plane)})`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
