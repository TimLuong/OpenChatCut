// VI dictionary assembly: key = Chinese original text, value = Vietnamese.
// Core editing surfaces are translated; untranslated keys (settings, chat,
// components, library) fall back to English through dictRegistry.
import audio from './audio';
import captions from './captions';
import editor from './editor';
import exportPanel from './exportPanel';
import fx from './fx';
import media from './media';
import review from './review';
import settings from './settings';
import timeline from './timeline';
import topbar from './topbar';
import transcript from './transcript';

export const VI: Record<string, string> = Object.assign(
  {},
  audio, captions, editor, exportPanel, fx, media, review, settings, timeline, topbar, transcript,
);
