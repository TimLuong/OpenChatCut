export { REMOVE_BACKGROUND_TOOL_SCHEMAS, REMOVE_BACKGROUND_TOOL_NAMES } from './schemas/remove-background-tools';
// remove_background — matte a video clip into a transparent pool asset.
import type { AgentContext } from '../context';
import type { MediaAsset } from '../../editor/types';
import { removeBackgroundOnSrc, type RemoveBackgroundResult } from '../../media/removeBackground';

type Args = Record<string, unknown>;

const uid = (): string => (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`);

type Runner = (src: string, opts: { force?: boolean }) => Promise<RemoveBackgroundResult>;

/** Test seam: build the executor around a matting runner. */
export function createRemoveBackgroundTool(run: Runner) {
  return (name: string, args: Args, ctx: AgentContext): Promise<unknown> => execWith(run, name, args, ctx);
}

export const execRemoveBackgroundTool = createRemoveBackgroundTool(removeBackgroundOnSrc);

async function execWith(run: Runner, name: string, args: Args, ctx: AgentContext): Promise<unknown> {
  if (name !== 'remove_background') return { error: `unknown tool ${name}` };
  const state = ctx.getState();
  const query = String(args.itemId ?? '').trim();
  const item = query ? state.items.find((it) => it.id === query || it.id.startsWith(query)) : undefined;
  if (!item) {
    return {
      error: `clip not found: ${query || '(missing itemId)'}`,
      available: state.items.filter((it) => it.kind === 'video').map((it) => ({ itemId: it.id, name: it.name })),
    };
  }
  if (item.kind !== 'video' || !item.src) return { error: `remove_background needs a video clip, got kind=${item.kind}` };

  let result: RemoveBackgroundResult;
  try {
    result = await run(item.src, { force: args.force === true });
  } catch (error) {
    return { error: `background removal failed: ${error instanceof Error ? error.message : String(error)}` };
  }

  const assets = ctx.getDoc().assets ?? state.assets ?? [];
  const source = assets.find((asset) => asset.src === item.src);
  const existing = assets.find((asset) => asset.kind === 'video' && asset.src === result.path);
  const next = (assetId: string) =>
    `Swap the clip in place with edit_item updates:[{itemId:"${item.id}", assetId:"${assetId}"}], then add the new background on a lower video track.`;
  if (existing) {
    return { ok: true, itemId: item.id, assetId: existing.id, src: existing.src, deduped: true, next: next(existing.id) };
  }
  const asset: MediaAsset = {
    id: uid(),
    name: `${source?.name ?? item.name ?? 'clip'} (no background)`,
    kind: 'video',
    src: result.path,
    durationInFrames: source?.durationInFrames ?? item.durationInFrames,
  };
  ctx.commands.addAsset(asset);
  return {
    ok: true,
    itemId: item.id,
    assetId: asset.id,
    src: asset.src,
    width: result.width,
    height: result.height,
    cached: result.cached,
    next: next(asset.id),
  };
}
