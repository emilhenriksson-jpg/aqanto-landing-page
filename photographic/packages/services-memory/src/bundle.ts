/**
 * The bundle: everything a model is handed before the person types.
 *
 * This is the whole promise of the product in one object. If it is wrong, slow or
 * missing, nothing else in the system matters — the person opens a chat and has to
 * explain themselves again, which is the exact experience they came here to stop.
 *
 * Assembled from cached projections rather than from raw items, because a voice session
 * cannot wait for a profile to be packed.
 */

import type {
  Actor,
  BundlePort,
  ContextBundle,
  ProjectionPort,
  RoomId,
  RoomPort,
} from '@photographic/core';
import { BUNDLE_TOKEN_BUDGET, estimateTokens } from '@photographic/core';
import { renderInstructions } from '@photographic/agent';

import { MemoryStore } from './store.js';

export class MemoryBundle implements BundlePort {
  constructor(
    private readonly store: MemoryStore,
    private readonly projection: ProjectionPort,
    private readonly rooms: RoomPort,
  ) {}

  async build(
    actor: Actor,
    input: { activeRoomId?: RoomId; budgetTokens?: number } = {},
  ): Promise<ContextBundle> {
    const profile = await this.projection.getProfile(actor.personId);
    const rooms = await this.rooms.listForPerson(actor);

    // An active room id from a model is a request, not a grant. `activeRoomContext`
    // resolves the permission itself and throws if it does not hold, so a wrong or
    // guessed id cannot widen what this bundle contains.
    const activeRoom = input.activeRoomId
      ? await this.projection.activeRoomContext(actor, input.activeRoomId)
      : null;

    const bundle: ContextBundle = {
      personId: actor.personId,
      profile,
      rooms,
      activeRoom,
      tokenCount: 0,
      bundleVersion: `${profile.version}.${rooms.length}.${activeRoom ? 1 : 0}`,
      builtAt: this.store.now(),
    };

    // Measured from the string that actually reaches the model, not summed from the
    // parts: the parts do not include the scaffolding, and the scaffolding is what
    // makes a budget overrun show up as a silently truncated profile.
    bundle.tokenCount = estimateTokens(
      this.render(bundle, input.budgetTokens ?? BUNDLE_TOKEN_BUDGET),
    );

    return bundle;
  }

  render(bundle: ContextBundle, budgetTokens = BUNDLE_TOKEN_BUDGET): string {
    return renderInstructions(bundle, { budgetTokens });
  }
}
