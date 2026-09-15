import { describe, expect, it } from 'vitest';

import type { RoomId } from './domain.js';
import { NotPermittedError } from './errors.js';
import type { Actor } from './ports.js';
import { routeMemory, type RoutingCandidate, type RoutingDeps } from './routing.js';

const actor: Actor = {
  personId: 'emil' as never,
  agentClient: 'claude-desktop',
  sessionId: null,
  roomScope: [],
};

const personal: RoutingCandidate = {
  roomId: 'personal' as RoomId,
  kind: 'personal',
  title: 'Emil',
  headline: '',
  memberCount: 1,
  sample: ['Allergisk mot ketchup', 'Dottern heter Vera'],
};

const villan: RoutingCandidate = {
  roomId: 'villan' as RoomId,
  kind: 'shared',
  title: 'Villan',
  headline: 'Renovering av villan: offerter, hantverkare och tidplan',
  memberCount: 2,
  sample: ['Renoveringen av köket börjar i mars', 'Elektrikern heter Micke'],
};

const ledning: RoutingCandidate = {
  roomId: 'ledning' as RoomId,
  kind: 'shared',
  title: 'Buyersclub Ledning',
  headline: 'Beslut och riktning för Buyersclub-förvärvet',
  memberCount: 3,
  sample: ['Vi beslutade att skjuta förvärvet till Q3'],
};

const upphandling: RoutingCandidate = {
  roomId: 'upphandling' as RoomId,
  kind: 'shared',
  title: 'Upphandling',
  headline: 'Offerter och avtal med leverantörer',
  memberCount: 2,
  sample: ['Avtalet med Peab löper till årsskiftet'],
};

function deps(
  rooms: RoutingCandidate[],
  llm?: RoutingDeps['llm'],
): RoutingDeps {
  return { candidates: async () => rooms, ...(llm ? { llm } : {}) };
}

describe('where a memory goes when nobody said', () => {
  it('keeps something about the person in their private memory', async () => {
    const decision = await routeMemory(deps([personal, villan, ledning]), actor, {
      body: 'Allergisk mot skaldjur',
    });

    expect(decision.placement).toBe('private');
    expect(decision.roomId).toBe('personal');
    expect(decision.motivation).toBe('Sparat privat eftersom det handlar om dig.');
  });

  it('finds the room a memory is plainly about, and says what it matched on', async () => {
    const decision = await routeMemory(deps([personal, villan, ledning]), actor, {
      body: 'Elektrikern bokar in renoveringen av köket i mars',
    });

    expect(decision.placement).toBe('room');
    expect(decision.roomTitle).toBe('Villan');
    // An explanation, not a verdict: a person who disagrees can see what we matched on.
    expect(decision.motivation).toMatch(/^Hör till Villan eftersom det nämner /);
    // Quoted as they wrote it. Matching happens on stripped, stemmed tokens; explaining
    // does not — "eftersom det nämner renovering, koke" is the inside of the matcher.
    expect(decision.motivation).toContain('renoveringen');
    expect(decision.motivation).not.toMatch(/koke\b/);
  });

  it('stays private when two rooms match about equally', async () => {
    // Several matches is a question, not a close call to settle by arithmetic — the same
    // reasoning that stops a spoken room name resolving to a guess.
    const twin: RoutingCandidate = { ...villan, roomId: 'villan-2' as RoomId, title: 'Villan igen' };

    const decision = await routeMemory(deps([personal, villan, twin]), actor, {
      body: 'Renoveringen av köket börjar i mars',
    });

    expect(decision.placement).toBe('private');
    expect(decision.uncertainty).toMatch(/både/);
  });

  it('never routes an instruction, however well the words match', async () => {
    // An instruction is a fact about how the person wants every model to behave, not
    // about any room's subject.
    const decision = await routeMemory(deps([personal, villan]), actor, {
      body: 'Fråga alltid om renoveringen av köket innan du föreslår något',
      kind: 'instruction',
    });

    expect(decision.placement).toBe('private');
  });

  it('routes nowhere but private when the person has no other rooms', async () => {
    const decision = await routeMemory(deps([personal]), actor, {
      body: 'Renoveringen av köket börjar i mars',
    });

    expect(decision.placement).toBe('private');
  });

  it('refuses to invent a destination when there is no private room to fall back to', async () => {
    // Rather than quietly choosing someone else's room, which is the one thing routing
    // must never do.
    await expect(
      routeMemory(deps([villan, ledning]), actor, { body: 'Köket renoveras i mars' }),
    ).rejects.toThrow(NotPermittedError);
  });

  /**
   * Routing is the path where no room is named, so it is the path a narrowed token would
   * otherwise slip through: ask for nowhere in particular and land in the personal room
   * the token was never issued for.
   */
  describe('a token narrowed to some rooms', () => {
    const narrowed: Actor = { ...actor, roomScope: ['villan' as RoomId] };

    it('cannot be routed into a room outside its scope', async () => {
      await expect(
        routeMemory(deps([personal, villan, ledning]), narrowed, {
          body: 'Allergisk mot skaldjur',
        }),
      ).rejects.toThrow(NotPermittedError);
    });

    it('still routes normally inside its scope', async () => {
      const withPersonal: Actor = { ...actor, roomScope: ['personal', 'villan'] as RoomId[] };

      const decision = await routeMemory(deps([personal, villan, ledning]), withPersonal, {
        body: 'Elektrikern bokar in renoveringen av köket i mars',
      });

      expect(decision.roomTitle).toBe('Villan');
      // And the room it was never issued for was not even weighed.
      expect(decision.considered.map((room) => room.title)).toEqual(['Villan']);
    });
  });
});

/**
 * The property that makes routing safe to ship: a model can only ever make the outcome
 * more private. It is the same asymmetry as `explicit` in `requiresApproval` — untrusted
 * input may tighten a decision and never loosen it.
 */
describe('what the model is allowed to do', () => {
  it('lets it veto a room the words matched but the subject does not', async () => {
    const decision = await routeMemory(
      deps([personal, villan], {
        confirmPlacement: async () => ({
          belongs: false,
          because: 'Handlar om varumärket, inte om huset.',
        }),
      }),
      actor,
      { body: 'Renoveringen av varumärket och köket drar igång i mars' },
    );

    expect(decision.placement).toBe('private');
    expect(decision.motivation).toContain('Handlar om varumärket');
  });

  it('cannot promote a room the words did not already shortlist', async () => {
    // Even a model insisting everything belongs somewhere shared changes nothing: it is
    // never asked which room, only whether the shortlisted one holds up.
    const decision = await routeMemory(
      deps([personal, ledning], { confirmPlacement: async () => ({ belongs: true }) }),
      actor,
      { body: 'Allergisk mot skaldjur' },
    );

    expect(decision.placement).toBe('private');
  });

  it('keeps the lexical decision when the model is unavailable', async () => {
    // An outage must not change where a memory lands. Routing has to behave the same
    // against the deterministic fake, an unconfigured process and a provider having a
    // bad afternoon — otherwise it is a feature nobody can reason about.
    const decision = await routeMemory(
      deps([personal, villan], {
        confirmPlacement: async () => {
          throw new Error('503 from the provider');
        },
      }),
      actor,
      { body: 'Elektrikern bokar in renoveringen av köket i mars' },
    );

    expect(decision.placement).toBe('room');
    expect(decision.roomTitle).toBe('Villan');
  });

  it('still only ever narrows, now that the matcher stems better', async () => {
    // Better matching means more memories reach a room, which is the point — and it is
    // also the change that could quietly widen what a model gets to influence. It does
    // not: a stemmed match strong enough to clear ROUTING_MIN_SCORE is still only a
    // candidate, and a veto still sends it private. The asymmetry is in the shape of the
    // call, not in how good the shortlist is.
    const decision = await routeMemory(
      deps([personal, upphandling], {
        confirmPlacement: async () => ({
          belongs: false,
          because: 'Handlar om hemmet, inte om upphandlingen.',
        }),
      }),
      actor,
      { body: 'Leverantörens offert på fönsterbytet kom in idag' },
    );

    expect(decision.placement).toBe('private');
    expect(decision.motivation).toContain('Handlar om hemmet');
  });

  it('works identically with no model at all', async () => {
    const withModel = await routeMemory(
      deps([personal, villan], { confirmPlacement: async () => ({ belongs: true }) }),
      actor,
      { body: 'Elektrikern bokar in renoveringen av köket i mars' },
    );
    const without = await routeMemory(deps([personal, villan]), actor, {
      body: 'Elektrikern bokar in renoveringen av köket i mars',
    });

    expect(without.roomId).toBe(withModel.roomId);
    expect(without.motivation).toBe(withModel.motivation);
  });
});

describe('what a routed room placement says about itself', () => {
  it('flags that a room reaches other people, and asks rather than assumes', async () => {
    const decision = await routeMemory(deps([personal, ledning]), actor, {
      body: 'Förvärvet av Buyersclub skjuts till Q3 enligt ledningen',
    });

    expect(decision.placement).toBe('room');
    expect(decision.reachesOtherPeople).toBe(true);
    // Never silent about a room other people read, even when the match was strong.
    expect(decision.uncertainty).toMatch(/läses av andra/);
  });

  it('matches a genitive the old hand-rolled suffix list could not', async () => {
    // Why this file now imports `swedishStem` instead of carrying its own suffix list.
    // The old list was ['arna','erna','orna','ande','are','ade','en','et','ar','er','or'],
    // which has no genitive in it at all: "leverantörens" stayed "leverantorens" and so
    // never met the room's own "leverantörer" -> "leverantör". Snowball's step 1 has
    // "ens", so both sides now reach "leverantör" and the memory finds its room.
    const decision = await routeMemory(deps([personal, upphandling, ledning]), actor, {
      body: 'Leverantörens offert på fönsterbytet kom in idag',
    });

    expect(decision.placement).toBe('room');
    expect(decision.roomTitle).toBe('Upphandling');
    expect(decision.motivation).toContain('Leverantörens');
  });

  it('shows what it considered, so a placement can be argued with', async () => {
    const decision = await routeMemory(deps([personal, villan, ledning]), actor, {
      body: 'Elektrikern bokar in renoveringen av köket i mars',
    });

    expect(decision.considered.map((room) => room.title)).toEqual([
      'Villan',
      'Buyersclub Ledning',
    ]);
    expect(decision.considered[0]!.score).toBeGreaterThan(decision.considered[1]!.score);
  });
});
