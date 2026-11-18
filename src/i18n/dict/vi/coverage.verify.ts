// Every Vietnamese entry must translate a key that exists in the English
// dictionary and keep that entry's {placeholder} set — t() substitutes by
// name, so a dropped or renamed placeholder would leak a raw "{n}" into the UI.
// Missing entries are fine: Vietnamese falls back to English.
// npx tsx src/i18n/dict/vi/coverage.verify.ts
import assert from 'node:assert/strict';
import { EN } from '../en';
import { VI } from './index';

function placeholders(text: string): string {
  return [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort().join(',');
}

const orphaned = Object.keys(VI).filter((key) => !(key in EN));
assert.deepEqual(orphaned, [], `Vietnamese entries without an English source:\n${orphaned.join('\n')}`);

const mismatched = Object.entries(VI)
  .filter(([key, vietnamese]) => placeholders(vietnamese) !== placeholders(EN[key] ?? key))
  .map(([key, vietnamese]) => `${key} → ${vietnamese}`);
assert.deepEqual(mismatched, [], `Vietnamese placeholders differ from the source entry:\n${mismatched.join('\n')}`);

const empty = Object.entries(VI).filter(([, vietnamese]) => vietnamese.trim() === '' && vietnamese !== '');
assert.deepEqual(empty, [], 'Vietnamese entries must not be whitespace-only');

console.log(`vi coverage.verify: ${Object.keys(VI).length} Vietnamese entries keep their placeholders (${Object.keys(EN).length} English entries)`);
