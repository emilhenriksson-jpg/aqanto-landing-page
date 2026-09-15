import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

describe('voice placeholder', () => {
  it('ships a calm Swedish coming-soon shell', () => {
    const main = readFileSync(join(here, 'main.ts'), 'utf8');
    expect(main).toMatch(/Kommer snart/);
    expect(main).toMatch(/Photographic/);
    expect(main).toMatch(/wordmark/);
    expect(main).not.toMatch(/exclamation|🎉/i);
  });

  it('pulls colour from shared design tokens', () => {
    const css = readFileSync(join(here, 'styles/app.css'), 'utf8');
    expect(css).toMatch(/@photographic\/design-tokens\/tokens\.css/);
    expect(css).toMatch(/--brand/);
  });
});
