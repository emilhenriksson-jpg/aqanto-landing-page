#!/usr/bin/env node
/**
 * Creates package.json / tsconfig.json / vitest.config.ts for every workspace package
 * up front, so that a single `pnpm install` covers all of them and parallel agents
 * never race on the lockfile.
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';

const root = join(import.meta.dirname, '..');

/** @type {Array<{dir: string, name: string, deps?: Record<string,string>, bin?: string}>} */
const packages = [
  { dir: 'packages/db', name: '@photographic/db', deps: { pg: '^8.13.1' } },
  { dir: 'packages/auth', name: '@photographic/auth', deps: { jose: '^5.9.6' } },
  { dir: 'packages/rooms', name: '@photographic/rooms' },
  { dir: 'packages/ingest', name: '@photographic/ingest' },
  { dir: 'packages/projection', name: '@photographic/projection' },
  { dir: 'packages/retrieval', name: '@photographic/retrieval' },
  { dir: 'packages/documents', name: '@photographic/documents' },
  { dir: 'packages/llm', name: '@photographic/llm', deps: { openai: '^4.77.0' } },
  {
    dir: 'apps/rest',
    name: '@photographic/rest',
    deps: { hono: '^4.6.14', '@hono/node-server': '^1.13.7', zod: '^3.24.1' },
  },
  {
    dir: 'apps/mcp',
    name: '@photographic/mcp',
    deps: { '@modelcontextprotocol/sdk': '^1.12.0', hono: '^4.6.14', '@hono/node-server': '^1.13.7', zod: '^3.24.1' },
  },
  {
    dir: 'apps/web',
    name: '@photographic/web',
    deps: { hono: '^4.6.14', '@hono/node-server': '^1.13.7' },
  },
  {
    dir: 'apps/voice',
    name: '@photographic/voice',
    deps: { hono: '^4.6.14', '@hono/node-server': '^1.13.7' },
  },
];

const workspaceDeps = {
  '@photographic/core': 'workspace:*',
};

for (const pkg of packages) {
  const abs = join(root, pkg.dir);
  mkdirSync(join(abs, 'src'), { recursive: true });

  const pkgJsonPath = join(abs, 'package.json');
  if (!existsSync(pkgJsonPath)) {
    writeFileSync(
      pkgJsonPath,
      `${JSON.stringify(
        {
          name: pkg.name,
          version: '0.0.0',
          private: true,
          type: 'module',
          exports: { '.': './src/index.ts' },
          scripts: {
            typecheck: 'tsc --noEmit',
            test: 'vitest run',
            build: 'tsc --emitDeclarationOnly --outDir dist',
          },
          dependencies: { ...workspaceDeps, ...(pkg.deps ?? {}) },
          devDependencies: { typescript: '^5.7.2', vitest: '^2.1.8', '@types/node': '^22.10.2' },
        },
        null,
        2,
      )}\n`,
    );
  }

  const depth = pkg.dir.split('/').length;
  const up = '../'.repeat(depth);

  const tsconfigPath = join(abs, 'tsconfig.json');
  if (!existsSync(tsconfigPath)) {
    writeFileSync(
      tsconfigPath,
      `${JSON.stringify(
        {
          extends: `${up}tsconfig.base.json`,
          compilerOptions: { rootDir: 'src', outDir: 'dist' },
          include: ['src/**/*'],
        },
        null,
        2,
      )}\n`,
    );
  }

  const vitestPath = join(abs, 'vitest.config.ts');
  if (!existsSync(vitestPath)) {
    writeFileSync(vitestPath, `export { default } from '${up}vitest.shared.js';\n`);
  }

  const indexPath = join(abs, 'src/index.ts');
  if (!existsSync(indexPath)) {
    writeFileSync(indexPath, `export {};\n`);
  }

  console.log(`scaffolded ${pkg.name}`);
}
