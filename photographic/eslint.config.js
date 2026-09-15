/**
 * The linter, chosen for the bugs it catches rather than the style it enforces.
 *
 * There was no linter before this, which is why `pnpm lint` passed by doing nothing. The
 * temptation with a first config is to turn on a recommended preset and leave the
 * codebase red, which teaches everyone to run the build with the failure scrolled past.
 * So this is the opposite: type-aware rules that each answer for a real bug class in
 * this repository, measured against the whole workspace before being switched on, and
 * landed green.
 *
 * `@typescript-eslint/no-floating-promises` is the reason to have this at all, and it is
 * configured with `ignoreVoid: false` rather than the default. The bug that earns it has
 * already happened here: the trash sweep in `apps/rest/src/server.ts` was
 * `void wiring.purgeTrash().then(...)` with no `.catch()`, between two timers that both
 * had one, and under Node 22 an unhandled rejection ends the process — on the one machine
 * that serves everything. It is fixed on `main` now, and the comment beside the fix
 * explains it well. What matters for this file is which setting would have caught it:
 * the default `ignoreVoid: true` treats `void promise` as a deliberate fire-and-forget
 * and says nothing, so the default configuration of the single most valuable rule here
 * would have stayed silent through the whole incident. `server.ts:106` still has one of
 * the same shape on the shutdown path.
 *
 * The 15 floating promises that remain, and the rest of what was already there, are
 * recorded in `eslint-suppressions.json` rather than silenced with inline comments or
 * left as warnings. Same ratchet as `scripts/test-doubles-baseline.json`: a new one
 * fails, the list can only shrink, `pnpm lint:prune` takes rows out as they are fixed.
 * ESLint also fails on a suppression that no longer matches, so fixing one and not
 * pruning is a build failure rather than a growing lie.
 *
 * What is deliberately off, so nobody has to rediscover why:
 *
 *  - `require-await` — 210 hits, almost all of them port methods that are `async` to
 *    satisfy an interface and have nothing to await. The rule is right about the code and
 *    wrong about the design, and 210 suppressions would bury the 15 that matter.
 *  - `no-unsafe-*` in test files — 1,373 of the 1,786 findings in the first measured run
 *    came from these four rules inside tests, essentially all of them from the `any`
 *    harness in `e2e`. In production source the same rules find four. So they are errors
 *    where they describe a boundary and off where they describe a test fixture; that is
 *    the difference between a linter people keep and one they delete.
 *  - `no-undef` for TypeScript, which the compiler already does better.
 *  - Formatting. There is no Prettier here and this config adds no stylistic rules,
 *    because a diff full of quote changes is how a useful check gets ignored.
 */

import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/*.d.ts',
      '.ci-reports/**',
      // Build configuration, in no tsconfig, so type-aware linting cannot see it. Not
      // product code; excluded rather than given a second parser setup to maintain.
      '**/vitest.config.ts',
      '**/vitest.*.config.ts',
      '**/vite.config.ts',
      'vitest.shared.ts',
    ],
  },

  js.configs.recommended,

  // Node scripts. Plain JS, no type information, and `console`/`process` are globals
  // rather than undefined identifiers.
  {
    files: ['**/*.mjs', '**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
    },
  },

  {
    files: ['**/*.ts', '**/*.tsx'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      'no-undef': 'off',

      // The rule this config exists for. See the header.
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: false }],

      // Right about the code, wrong about the design. See the header.
      '@typescript-eslint/require-await': 'off',

      // An unused variable is usually a rename that did not finish. Leading underscore
      // is the escape hatch, and caught errors are exempt because `catch {}` with a
      // deliberate swallow is a pattern this codebase uses on purpose.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'none',
        },
      ],
    },
  },

  // `any` in a test fixture is a fixture. `any` crossing a boundary in product code is
  // the thing these rules are for, and there it is four occurrences, not 1,373.
  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/testing/**/*.ts', 'e2e/src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/no-base-to-string': 'off',
    },
  },

  // React. `exhaustive-deps` is here because `apps/web/src/hooks/useRoomData.ts` already
  // carries a disable comment for it, which means someone hit the stale-closure bug it
  // catches and had no linter to tell them so.
  {
    files: ['apps/web/**/*.{ts,tsx}', 'apps/onboarding/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
);
