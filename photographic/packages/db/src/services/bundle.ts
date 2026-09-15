/**
 * The bundle: everything a model is handed before the person types. See the
 * `services-memory` implementation of the same name for the reasoning; this only
 * differs in where the profile and rooms come from.
 */

import type { Actor, BundlePort, ContextBundle, ProjectionPort, RoomId, RoomPort } from '@photographic/core';
import { BUNDLE_TOKEN_BUDGET, estimateTokens } from '@photographic/core';
import { renderInstructions } from '@photographic/agent';

export class PgBundle implements BundlePort {
  constructor(
    private readonly projection: ProjectionPort,
    private readonly rooms: RoomPort,
  ) {}

  async build(
    actor: Actor,
    input: { activeRoomId?: RoomId; budgetTokens?: number } = {},
  ): Promise<ContextBundle> {
    const profile = await this.projection.getProfile(actor.personId);
    const rooms = await this.rooms.listForPerson(actor);

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
      builtAt: new Date(),
    };

    bundle.tokenCount = estimateTokens(this.render(bundle, input.budgetTokens ?? BUNDLE_TOKEN_BUDGET));
    return bundle;
  }

  render(bundle: ContextBundle, budgetTokens = BUNDLE_TOKEN_BUDGET): string {
    return renderInstructions(bundle, { budgetTokens });
  }
}
