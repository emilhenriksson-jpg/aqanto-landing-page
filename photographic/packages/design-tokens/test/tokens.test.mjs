import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(root, 'tokens.css'), 'utf8');

test('exports core DESIGN.md colour tokens', () => {
  for (const name of ['--canvas', '--surface', '--ink', '--brand', '--ok', '--warn', '--bad']) {
    assert.match(css, new RegExp(`${name}:`));
  }
});

test('exports motion tokens used by web and onboarding', () => {
  assert.match(css, /--ease-spring:/);
  assert.match(css, /--spring:\s*var\(--ease-spring\)/);
  assert.match(css, /prefers-reduced-motion/);
});
