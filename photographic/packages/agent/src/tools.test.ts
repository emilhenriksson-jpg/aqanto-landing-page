import { describe, expect, it } from 'vitest';

import { estimateTokens } from './instructions.js';
import { TOOL_NAMES, TOOLS, toolByName, toolWireFormat } from './tools.js';

describe('the tool set', () => {
  it('stays small enough that every definition can be loaded at once', () => {
    // Selection accuracy falls as the list grows, and clients are advised to switch to
    // progressive discovery once definitions pass a few percent of the context window.
    // Staying well under that is why folding undo into restore_memory was worth it.
    expect(TOOLS.length).toBeLessThanOrEqual(12);

    // Room creation and chat approval each earn a separate tool; keep their combined catalog bounded.
    // The ceiling is generous on purpose: descriptions are decision prompts, and a
    // vague `remember` costs far more than the tokens a precise one occupies.
    //
    // Measured on the wire format rather than on the definitions, because that is what
    // occupies the window. Fields the server does not forward — `scopes` — cost nothing
    // and should not eat the budget.
    expect(estimateTokens(JSON.stringify(TOOLS.map(toolWireFormat)))).toBeLessThan(6400);
  });

  it('uses distinct verbs rather than vague ones', () => {
    for (const name of TOOL_NAMES) {
      expect(name).not.toMatch(/^(handle|manage|do|process)_/);
      expect(name).toMatch(/^[a-z][a-z_]+$/);
    }
    expect(new Set(TOOL_NAMES).size).toBe(TOOL_NAMES.length);
  });

  it('tells every tool when not to use it, not only when to', () => {
    for (const tool of TOOLS) {
      expect(tool.description.length).toBeGreaterThan(200);
      expect(tool.description).toMatch(/Do not|does not return|Does not return|never|Only works/i);
    }
  });

  it('describes every parameter', () => {
    for (const tool of TOOLS) {
      for (const [name, property] of Object.entries(tool.inputSchema.properties)) {
        expect(property.description, `${tool.name}.${name}`).toBeTruthy();
        expect(property.description.length, `${tool.name}.${name}`).toBeGreaterThan(30);
      }
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
  });

  it('constrains the one free-text field that has a finite set of values', () => {
    const kind = toolByName('remember').inputSchema.properties.kind;
    expect(kind?.enum).toEqual([
      'fact',
      'preference',
      'instruction',
      'decision',
      'note',
      'never',
    ]);
  });

  it('defaults every optional limit so the model never has to guess', () => {
    for (const tool of TOOLS) {
      const limit = tool.inputSchema.properties.limit;
      if (limit) {
        expect(limit.default, tool.name).toBeDefined();
        expect(limit.maximum, tool.name).toBeDefined();
      }
    }
  });
});

describe('annotations', () => {
  it('marks the read-only tools read-only and nothing else', () => {
    const readOnly = TOOLS.filter((t) => t.annotations.readOnlyHint).map((t) => t.name).sort();
    expect(readOnly).toEqual(['get_context', 'list_history', 'list_trash', 'search_memory']);
  });

  it('does not mark the soft delete destructive', () => {
    // Marking it destructive makes clients confirm every "glöm det", which is the
    // friction the 30-day trash exists to remove.
    expect(toolByName('forget_memory').annotations.destructiveHint).toBe(false);
    expect(TOOLS.every((t) => t.annotations.destructiveHint === false)).toBe(true);
  });

  it('gives every tool a human title for the client UI', () => {
    for (const tool of TOOLS) {
      expect(tool.annotations.title.length).toBeGreaterThan(3);
    }
  });
});

describe('what the write rules actually say', () => {
  const remember = toolByName('remember').description;

  it('makes instructions always require approval', () => {
    expect(remember).toMatch(/instruction/);
    expect(remember).toMatch(/always need approval/i);
  });

  it('refuses to save guesses without confirmation', () => {
    expect(remember).toMatch(/inferred it rather than being told/i);
  });

  it('refuses secrets outright', () => {
    expect(remember).toMatch(/passwords, API keys/i);
  });

  it('forbids carrying shared-room content into the personal room', () => {
    expect(remember).toMatch(/shared room, into their personal room/i);
  });

  it('tells the model what to do for each outcome, including saying nothing', () => {
    expect(remember).toMatch(/saved/);
    expect(remember).toMatch(/proposed/);
    expect(remember).toMatch(/duplicate/);
    expect(remember).toMatch(/Say nothing at all/i);
  });

  it('asks for the memory in the person\u2019s own voice', () => {
    expect(remember).toMatch(/Allergisk mot ketchup/);
    expect(remember).toMatch(/not as a note about them/i);
  });
});

describe('deleting and getting things back', () => {
  it('tells the model deletion is reversible, and for how long', () => {
    const forget = toolByName('forget_memory').description;
    expect(forget).toMatch(/30 days/);
    expect(forget).toMatch(/trash/i);
    // The point of the trash is that it removes a confirmation step.
    expect(forget).toMatch(/without asking for confirmation/i);
  });

  it('requires an id rather than free text', () => {
    const forget = toolByName('forget_memory');
    expect(forget.inputSchema.required).toEqual(['id']);
    expect(forget.description).toMatch(/Always use an id, never free text/i);
  });

  it('never invents an id', () => {
    for (const tool of TOOLS) {
      const id = tool.inputSchema.properties.id;
      if (id) expect(id.description).toMatch(/Never invent or guess one|from list_trash|provenance/i);
    }
  });

  it('accepts either an undo token or an id when restoring', () => {
    const restore = toolByName('restore_memory');
    expect(restore.inputSchema.properties.undo_token).toBeDefined();
    expect(restore.inputSchema.properties.id).toBeDefined();
    expect(restore.inputSchema.required).toBeUndefined();
  });

  it('is honest that purged memories cannot be recovered by anyone', () => {
    expect(toolByName('restore_memory').description).toMatch(/including support/i);
  });
});

describe('history as the accountability story', () => {
  const history = toolByName('list_history').description;

  it('answers both "what happened" and "how do you know that"', () => {
    expect(history).toMatch(/what has been going on/i);
    expect(history).toMatch(/why do\s+you know that about me/i);
  });

  it('keeps showing that something was removed after it is purged', () => {
    expect(history).toMatch(/without showing what it was/i);
  });
});
