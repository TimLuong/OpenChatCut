// npx tsx src/agent/tools/remove-background-tools.verify.ts
import assert from 'node:assert/strict';
import type { AgentContext } from '../context.ts';
import type { MediaAsset } from '../../editor/types.ts';
import { createRemoveBackgroundTool, REMOVE_BACKGROUND_TOOL_SCHEMAS } from './remove-background-tools.ts';

const source: MediaAsset = {
  id: 'asset_interview', name: 'Phỏng vấn', kind: 'video', src: '/media/uploads/interview.mp4', durationInFrames: 300,
};
const assets: MediaAsset[] = [source];
const items = [
  { id: 'clip_video_1', kind: 'video', name: 'Phỏng vấn', src: source.src, durationInFrames: 120 },
  { id: 'clip_text_2', kind: 'text', name: 'Title' },
];
const ctx = {
  getState: () => ({ items, assets }),
  getDoc: () => ({ assets }),
  commands: { addAsset: (asset: MediaAsset) => { assets.push(asset); } },
} as unknown as AgentContext;

const calls: Array<{ src: string; force?: boolean }> = [];
const tool = createRemoveBackgroundTool(async (src, opts) => {
  calls.push({ src, force: opts.force });
  return { path: '/media/uploads/interview.matte.r1.rvm-mbv3-v1.webm', width: 1920, height: 1080, fps: 30, cached: false };
});

assert.equal(REMOVE_BACKGROUND_TOOL_SCHEMAS[0]!.name, 'remove_background');

const first = await tool('remove_background', { itemId: 'clip_video' }, ctx) as Record<string, unknown>;
assert.equal(first.ok, true);
assert.equal(calls[0]!.src, source.src, 'the clip source is matted');
assert.equal(assets.length, 2, 'a new pool asset is added');
const added = assets[1]!;
assert.equal(added.kind, 'video');
assert.equal(added.src, '/media/uploads/interview.matte.r1.rvm-mbv3-v1.webm');
assert.equal(added.name, 'Phỏng vấn (no background)');
assert.equal(added.durationInFrames, 300, 'duration follows the source asset, not the trimmed clip');
assert.match(String(first.next), /edit_item updates:\[\{itemId:"clip_video_1", assetId:"/);

const again = await tool('remove_background', { itemId: 'clip_video_1', force: true }, ctx) as Record<string, unknown>;
assert.equal(again.deduped, true, 'the same matte output reuses the pool asset');
assert.equal(assets.length, 2);
assert.equal(calls[1]!.force, true);

const text = await tool('remove_background', { itemId: 'clip_text_2' }, ctx) as Record<string, unknown>;
assert.match(String(text.error), /needs a video clip/);
const missing = await tool('remove_background', { itemId: 'nope' }, ctx) as Record<string, unknown>;
assert.match(String(missing.error), /clip not found/);

const failing = createRemoveBackgroundTool(async () => { throw new Error('model download failed (HTTP 403)'); });
const failed = await failing('remove_background', { itemId: 'clip_video_1' }, ctx) as Record<string, unknown>;
assert.match(String(failed.error), /background removal failed: model download failed/);

console.log('remove-background-tools.verify: matte becomes a pool asset with a swap hint; errors are reported');
