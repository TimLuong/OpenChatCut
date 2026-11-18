import type { AgentToolSchema } from '../../tool-schema';

export const REMOVE_BACKGROUND_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'remove_background',
    description:
      'Remove the background behind a person in a video clip without a green screen (on-device Robust Video Matting). ' +
      'Creates a new transparent video asset (VP9 WebM with alpha, original audio kept) in the media pool; the source media is never modified. ' +
      'Then place it with edit_item updates:[{itemId:"<clip>", assetId:"<new asset>"}] to swap the clip in place, and put the new background on a lower video track. ' +
      'Runs locally and can take about as long as the clip on a laptop CPU. Requires a /media/uploads source.',
    input_schema: {
      type: 'object',
      properties: {
        itemId: { type: 'string', description: 'Target video clip id (prefix ok).' },
        force: {
          type: 'boolean',
          description: 'Create a fresh matte even if one already exists for this source revision.',
        },
      },
      required: ['itemId'],
    },
  },
];

export const REMOVE_BACKGROUND_TOOL_NAMES = new Set(REMOVE_BACKGROUND_TOOL_SCHEMAS.map((t) => t.name));
