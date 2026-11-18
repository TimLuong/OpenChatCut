// POST /api/remove-background — background removal without a green screen.
//
// Robust Video Matting (RVM, GPL-3.0, github.com/PeterL1n/RobustVideoMatting)
// runs frame by frame in onnxruntime-node, carrying its recurrent state from
// frame to frame so the matte stays temporally stable. The result is written
// next to the source as a VP9 WebM with an alpha channel (yuva420p): the
// player and the export pipeline treat it as an ordinary transparent video,
// so a background placed on a lower track shows through.
//
// Body: { src: '/media/uploads/…', sourceRevision?: string, force?: boolean }
// Reply: { path: '/media/uploads/<matte>.webm', frames, width, height, fps, cached }
//
// The model (≈15 MB) is fetched once from the RVM GitHub release and pinned
// by SHA-256; nothing is uploaded anywhere.
import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { basename, dirname, join } from 'node:path';
import { editorCredentialAuthorized } from '../editor-auth.ts';
import { ffmpegBin, ffprobeBin } from '../media-binaries.ts';
import { isSafeUploadName, resolveUploadFile, uploadDir } from '../media-dir.ts';
import { proxyDispatcher } from '../outbound-proxy.ts';
import { modelCacheDir } from './hf-proxy.ts';

export const MATTING_ENGINE_VERSION = 'rvm-mbv3-v1';

export const RVM_MODEL = {
  fileName: 'rvm_mobilenetv3_fp32.onnx',
  url: 'https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/rvm_mobilenetv3_fp32.onnx',
  sizeBytes: 14_975_696,
  sha256: '88d4531297118f595bf2fd60f6f566aec2e559393802d1f436c380f0cbbd2828',
  license: 'GPL-3.0',
} as const;

/** Longest edge the matte is produced at; larger sources are scaled down. */
export const MAX_MATTE_EDGE = 1920;
/** RVM works best when its internal backbone sees roughly this many pixels on the long edge. */
const BACKBONE_EDGE = 512;
const MAX_JSON = 8 * 1024;

export function rvmModelPath(cacheDir: string = modelCacheDir()): string {
  return join(cacheDir, 'rvm', RVM_MODEL.fileName);
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

let modelDownload: Promise<string> | null = null;

/** Download the pinned RVM model once; concurrent callers share one download. */
export function ensureRvmModel(path: string = rvmModelPath()): Promise<string> {
  if (existsSync(path)) return Promise.resolve(path);
  modelDownload ??= (async () => {
    await mkdir(dirname(path), { recursive: true });
    const partial = `${path}.${randomUUID()}.part`;
    try {
      const dispatcher = proxyDispatcher();
      const response = await fetch(RVM_MODEL.url, dispatcher ? ({ dispatcher } as RequestInit) : {});
      if (!response.ok || !response.body) throw new Error(`model download failed (HTTP ${response.status})`);
      await pipeline(Readable.fromWeb(response.body as never), createWriteStream(partial));
      const actual = await sha256File(partial);
      if (actual !== RVM_MODEL.sha256) throw new Error(`model SHA-256 mismatch: expected ${RVM_MODEL.sha256}, got ${actual}`);
      await rename(partial, path);
      return path;
    } catch (error) {
      await unlink(partial).catch(() => undefined);
      throw error;
    } finally {
      modelDownload = null;
    }
  })();
  return modelDownload;
}

export interface VideoGeometry {
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly hasAudio: boolean;
}

function parseRate(value: unknown): number {
  const [num, den] = String(value ?? '').split('/').map(Number);
  const rate = den ? num! / den : Number(num);
  return Number.isFinite(rate) && rate > 0 ? rate : 30;
}

/** Even output size, long edge capped at MAX_MATTE_EDGE (yuva420p needs even dimensions). */
export function matteSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, MAX_MATTE_EDGE / Math.max(width, height));
  const even = (value: number) => Math.max(2, Math.round((value * scale) / 2) * 2);
  return { width: even(width), height: even(height) };
}

export function downsampleRatio(width: number, height: number): number {
  return Math.min(1, BACKBONE_EDGE / Math.max(width, height));
}

export function probeVideo(path: string): Promise<VideoGeometry> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffprobeBin(), [
      '-v', 'error', '-print_format', 'json', '-show_streams', path,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => { out += chunk; });
    child.stderr.on('data', (chunk: Buffer) => { err += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffprobe exit ${code}: ${err.slice(-300)}`));
      const streams = (JSON.parse(out || '{}').streams ?? []) as Array<Record<string, unknown>>;
      const video = streams.find((stream) => stream.codec_type === 'video');
      if (!video) return reject(new Error('source has no video stream'));
      resolve({
        width: Number(video.width),
        height: Number(video.height),
        fps: parseRate(video.avg_frame_rate ?? video.r_frame_rate),
        hasAudio: streams.some((stream) => stream.codec_type === 'audio'),
      });
    });
  });
}

/** Planar float RGB in [0, 1] (the RVM `src` layout) from packed RGB24. */
export function rgb24ToPlanar(frame: Uint8Array, pixels: number, out = new Float32Array(pixels * 3)): Float32Array {
  for (let index = 0; index < pixels; index += 1) {
    out[index] = frame[index * 3]! / 255;
    out[pixels + index] = frame[index * 3 + 1]! / 255;
    out[pixels * 2 + index] = frame[index * 3 + 2]! / 255;
  }
  return out;
}

/** Packed RGBA from RVM's planar foreground and alpha. The foreground is
 *  colour-decontaminated, so edges carry no tint from the old background. */
export function planarToRgba(fgr: Float32Array, pha: Float32Array, pixels: number, out = new Uint8Array(pixels * 4)): Uint8Array {
  const byte = (value: number) => Math.max(0, Math.min(255, Math.round(value * 255)));
  for (let index = 0; index < pixels; index += 1) {
    out[index * 4] = byte(fgr[index]!);
    out[index * 4 + 1] = byte(fgr[pixels + index]!);
    out[index * 4 + 2] = byte(fgr[pixels * 2 + index]!);
    out[index * 4 + 3] = byte(pha[index]!);
  }
  return out;
}

export function mattingArtifactName(sourceName: string, sourceRevision: string, forceNonce?: string): string {
  const stem = (sourceName.replace(/\.[^.]+$/, '') || sourceName)
    .replace(/[^a-zA-Z0-9_一-鿿-]+/g, '_').slice(0, 72) || 'media';
  const segment = (value: string) => value.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 80) || 'unknown';
  return [stem, 'matte', segment(sourceRevision), MATTING_ENGINE_VERSION, forceNonce && segment(forceNonce), 'webm']
    .filter(Boolean)
    .join('.');
}

/** Read exactly `size`-byte frames from a stream. */
async function* frames(stream: Readable, size: number): AsyncGenerator<Uint8Array> {
  let pending: Buffer = Buffer.alloc(0);
  for await (const chunk of stream) {
    pending = pending.length ? Buffer.concat([pending, chunk as Buffer]) : (chunk as Buffer);
    while (pending.length >= size) {
      yield new Uint8Array(pending.subarray(0, size));
      pending = pending.subarray(size);
    }
  }
}

function writeFrame(stream: NodeJS.WritableStream, data: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    if (stream.write(data, (error) => (error ? reject(error) : undefined))) resolve();
    else stream.once('drain', resolve);
  });
}

export interface MattingResult {
  readonly frames: number;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
}

/**
 * Matte `inputPath` into a transparent WebM at `outputPath`. The original
 * audio, if any, is carried over as Opus so the clip stays one piece.
 */
export async function removeBackgroundToFile(
  inputPath: string,
  outputPath: string,
  options: { modelPath?: string; signal?: AbortSignal; onProgress?: (frames: number) => void } = {},
): Promise<MattingResult> {
  const ort = await import('onnxruntime-node');
  const modelPath = options.modelPath ?? await ensureRvmModel();
  const session = await ort.InferenceSession.create(modelPath, { graphOptimizationLevel: 'all' });
  const source = await probeVideo(inputPath);
  const { width, height } = matteSize(source.width, source.height);
  const pixels = width * height;
  const partPath = outputPath.replace(/\.webm$/i, `.${randomUUID()}.tmp.webm`);

  const decoder = spawn(ffmpegBin(), [
    '-nostdin', '-hide_banner', '-loglevel', 'error',
    '-i', inputPath,
    '-map', '0:v:0',
    '-vf', `scale=${width}:${height}:flags=bicubic`,
    '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const encoder = spawn(ffmpegBin(), [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-r', String(source.fps), '-i', 'pipe:0',
    ...(source.hasAudio ? ['-i', inputPath, '-map', '0:v:0', '-map', '1:a:0', '-c:a', 'libopus', '-b:a', '128k'] : []),
    '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0',
    '-crf', '24', '-b:v', '0', '-deadline', 'good', '-cpu-used', '4', '-row-mt', '1',
    '-metadata:s:v:0', 'alpha_mode=1',
    '-shortest', partPath,
  ], { stdio: ['pipe', 'ignore', 'pipe'] });

  let stderr = '';
  for (const child of [decoder, encoder]) {
    child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk).slice(-2000); });
  }
  const exited = (child: ReturnType<typeof spawn>) => new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  const decoderExit = exited(decoder);
  const encoderExit = exited(encoder);
  const abort = () => { decoder.kill('SIGKILL'); encoder.kill('SIGKILL'); };
  options.signal?.addEventListener('abort', abort, { once: true });

  let count = 0;
  try {
    const zero = () => new ort.Tensor('float32', new Float32Array([0]), [1, 1, 1, 1]);
    let state: Record<string, InstanceType<typeof ort.Tensor>> = { r1i: zero(), r2i: zero(), r3i: zero(), r4i: zero() };
    const ratio = new ort.Tensor('float32', new Float32Array([downsampleRatio(width, height)]), [1]);
    const planar = new Float32Array(pixels * 3);
    const rgba = new Uint8Array(pixels * 4);
    for await (const frame of frames(decoder.stdout!, pixels * 3)) {
      if (options.signal?.aborted) throw new Error('background removal aborted');
      const src = new ort.Tensor('float32', rgb24ToPlanar(frame, pixels, planar), [1, 3, height, width]);
      const out = await session.run({ src, ...state, downsample_ratio: ratio });
      state = { r1i: out.r1o!, r2i: out.r2o!, r3i: out.r3o!, r4i: out.r4o! };
      await writeFrame(encoder.stdin!, planarToRgba(out.fgr!.data as Float32Array, out.pha!.data as Float32Array, pixels, rgba));
      count += 1;
      options.onProgress?.(count);
    }
    encoder.stdin!.end();
    const [decodeCode, encodeCode] = await Promise.all([decoderExit, encoderExit]);
    if (decodeCode !== 0) throw new Error(`ffmpeg decode exit ${decodeCode}: ${stderr.slice(-500)}`);
    if (encodeCode !== 0) throw new Error(`ffmpeg encode exit ${encodeCode}: ${stderr.slice(-500)}`);
    if (count === 0) throw new Error('source produced no video frames');
    await rename(partPath, outputPath);
    return { frames: count, width, height, fps: source.fps };
  } catch (error) {
    abort();
    await unlink(partPath).catch(() => undefined);
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', abort);
    await session.release().catch(() => undefined);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_JSON) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

// One matting job at a time: it saturates the CPU, and two at once only
// make both slower.
let queue: Promise<unknown> = Promise.resolve();

export function removeBackgroundPlugin(): Plugin {
  return {
    name: 'openchatcut-remove-background',
    configureServer(server) {
      server.middlewares.use('/api/remove-background', async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed — use POST' });
        if (!editorCredentialAuthorized(req, true)) return sendJson(res, 403, { error: 'editor origin required' });
        try {
          const body = await readJson(req);
          const src = decodeURIComponent((String(body.src ?? '').split('?')[0] ?? '').trim());
          const name = /^\/media\/uploads\/([^/]+)$/.exec(src)?.[1];
          if (!name || !isSafeUploadName(name)) return sendJson(res, 400, { error: 'src must be /media/uploads/<safe-name>' });
          const inputPath = resolveUploadFile(name);
          if (!inputPath) return sendJson(res, 404, { error: `media not found: ${name}` });
          const revision = String(body.sourceRevision ?? '').trim() || (await stat(inputPath)).mtimeMs.toString(36);
          const outName = mattingArtifactName(basename(inputPath), revision, body.force === true ? randomUUID() : undefined);
          const outPath = join(uploadDir(), outName);
          if (existsSync(outPath)) {
            const geometry = await probeVideo(outPath);
            return sendJson(res, 200, { path: `/media/uploads/${outName}`, cached: true, ...geometry });
          }
          const job = queue.then(() => removeBackgroundToFile(inputPath, outPath));
          queue = job.catch(() => undefined);
          const result = await job;
          sendJson(res, 200, { path: `/media/uploads/${outName}`, cached: false, ...result });
        } catch (error) {
          sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
        }
      });
    },
  };
}
