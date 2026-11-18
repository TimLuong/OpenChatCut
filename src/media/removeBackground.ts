// Client for POST /api/remove-background (server/plugins/remove-background.ts).

export interface RemoveBackgroundResult {
  readonly path: string;
  readonly frames?: number;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly cached: boolean;
}

export async function removeBackgroundOnSrc(
  src: string,
  opts: { force?: boolean; sourceRevision?: string; signal?: AbortSignal } = {},
): Promise<RemoveBackgroundResult> {
  if (!src.startsWith('/media/uploads/')) throw new Error('source must be uploaded to the media pool (/media/uploads) first');
  const res = await fetch('/api/remove-background', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ src, force: opts.force === true, sourceRevision: opts.sourceRevision }),
    signal: opts.signal,
  });
  const data = (await res.json().catch(() => ({}))) as Partial<RemoveBackgroundResult> & { error?: string };
  if (!res.ok || !data.path) throw new Error(data.error ?? `remove-background HTTP ${res.status}`);
  return {
    path: data.path,
    frames: data.frames,
    width: Number(data.width),
    height: Number(data.height),
    fps: Number(data.fps),
    cached: data.cached === true,
  };
}
