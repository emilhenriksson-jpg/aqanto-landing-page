/**
 * Per-tool scopes.
 *
 * The property worth protecting is at the bottom of this file: every tool names scopes
 * that actually exist in the vocabulary, and every write tool requires `memory.write`.
 * A tool added with a typo'd scope would be uncallable by every token; one added with no
 * write requirement would be callable by a connection the person granted read-only.
 */

import { SUPPORTED_SCOPES, DEFAULT_SCOPE, SCOPE_MEMORY_WRITE } from '@photographic/auth';
import { TOOLS } from '@photographic/agent';
import { describe, expect, it } from 'vitest';

import { toolsFor } from './server.js';

const defaultScopes = DEFAULT_SCOPE.split(' ');

describe('toolsFor', () => {
  it('offers the read tools to a client that asked for nothing', () => {
    const names = toolsFor(defaultScopes).map((tool) => tool.name);

    expect(names).toContain('get_context');
    expect(names).toContain('search_memory');
    expect(names).toContain('list_trash');
    expect(names).toContain('list_history');
  });

  it('hides every write tool from that same client', () => {
    // Filtered rather than offered-and-refused: a model that can see `remember` will use
    // it and then tell the person their memory was saved.
    const names = toolsFor(defaultScopes).map((tool) => tool.name);

    expect(names).not.toContain('remember');
    expect(names).not.toContain('update_memory');
    expect(names).not.toContain('forget_memory');
    expect(names).not.toContain('restore_memory');
  });

  it('offers everything to a token that was granted everything', () => {
    expect(toolsFor([...SUPPORTED_SCOPES])).toHaveLength(TOOLS.length);
  });

  it('offers nothing to a token with no scopes at all', () => {
    expect(toolsFor([])).toHaveLength(0);
  });

  it('does not offer a read tool to a write-only token', () => {
    // Scopes are capabilities, not levels. `memory.write` is not "read plus write".
    const names = toolsFor([SCOPE_MEMORY_WRITE]).map((tool) => tool.name);

    expect(names).toContain('remember');
    expect(names).not.toContain('search_memory');
    expect(names).not.toContain('get_context');
  });
});

describe('every tool has decided its scope', () => {
  it('names only scopes the authorization server can actually grant', () => {
    // A typo here would make a tool uncallable by every token ever issued, and the
    // symptom would be "the tool is missing" rather than anything pointing at a scope.
    const unknown = TOOLS.flatMap((tool) =>
      tool.scopes.filter((scope) => !SUPPORTED_SCOPES.includes(scope)),
    );

    expect(unknown).toEqual([]);
  });

  it('requires at least one scope per tool', () => {
    const unguarded = TOOLS.filter((tool) => tool.scopes.length === 0).map((t) => t.name);
    expect(unguarded).toEqual([]);
  });

  it('requires memory.write for every tool that is not read-only', () => {
    // Derived from the MCP annotation rather than from a second list, so a tool declared
    // as mutating cannot quietly be callable with a read-only token.
    const mutating = TOOLS.filter((tool) => !tool.annotations.readOnlyHint);
    expect(mutating.length).toBeGreaterThan(0);

    const missingWrite = mutating
      .filter((tool) => !tool.scopes.includes(SCOPE_MEMORY_WRITE))
      .map((tool) => tool.name);

    expect(missingWrite).toEqual([]);
  });

  it('never requires memory.write for a read-only tool', () => {
    // The other direction: a read tool that demanded write would make a read-only
    // connection useless, which is the failure nobody reports because the connection
    // looks like it worked.
    const overreaching = TOOLS.filter(
      (tool) => tool.annotations.readOnlyHint && tool.scopes.includes(SCOPE_MEMORY_WRITE),
    ).map((tool) => tool.name);

    expect(overreaching).toEqual([]);
  });
});
