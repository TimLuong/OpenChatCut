// Runs every voice-isolation filter chain through the bundled ffmpeg on a
// synthetic "speech + hiss" clip and checks that the primary chain is the one
// that succeeds and that it lowers the noise between syllables.
// npx tsx server/plugins/isolate-voice-chain.verify.ts
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ffmpegBin } from '../media-binaries.ts';
import { filterChains } from './isolate-voice.ts';

const ffmpeg = ffmpegBin();
const dir = mkdtempSync(join(tmpdir(), 'isolate-voice-chain-'));

function run(args: string[]): string {
  const result = spawnSync(ffmpeg, ['-hide_banner', '-nostdin', '-y', ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, `ffmpeg failed: ${result.stderr.slice(-400)}`);
  return result.stderr;
}

/** Mean volume (dB) of the gaps between syllables: 0.30–0.45 s of every 0.5 s. */
function gapVolume(path: string): number {
  const log = run([
    '-i', path,
    '-af', "aselect='between(mod(t\\,0.5)\\,0.30\\,0.45)',volumedetect",
    '-f', 'null', '-',
  ]);
  const match = /mean_volume:\s*(-?[\d.]+) dB/.exec(log);
  assert.ok(match, 'volumedetect reports a mean volume');
  return Number(match[1]);
}

try {
  // 220 Hz "voice" gated on for 0.25 s of every 0.5 s, plus steady pink noise.
  const source = join(dir, 'noisy.wav');
  run([
    '-f', 'lavfi', '-i', "sine=f=220:d=4,volume='if(lt(mod(t,0.5),0.25),0.5,0)':eval=frame",
    '-f', 'lavfi', '-i', 'anoisesrc=d=4:c=pink:a=0.05',
    '-filter_complex', 'amix=inputs=2:normalize=0',
    '-ar', '48000', source,
  ]);

  const chains = filterChains(70);
  assert.equal(chains.length, 4, 'four chains, best first');
  assert.match(chains[0]!, /afftdn=.*deesser=.*acompressor=/, 'the primary chain denoises, then de-esses and compresses');

  const outputs = chains.map((chain, index) => {
    const out = join(dir, `chain-${index}.m4a`);
    run(['-i', source, '-vn', '-af', chain, '-c:a', 'aac', '-b:a', '128k', out]);
    return out;
  });

  const before = gapVolume(source);
  const after = gapVolume(outputs[0]!);
  assert.ok(after < before - 6, `primary chain must cut gap noise by over 6 dB (before ${before} dB, after ${after} dB)`);
  console.log(`isolate-voice-chain.verify: all ${chains.length} chains run; gap noise ${before} dB → ${after} dB`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
