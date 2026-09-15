/**
 * The bundle: everything a model is handed before the person types. See the
 * `services-memory` implementation of the same name for the reasoning; this only
 * differs in where the profile and rooms come from.
 */

import type { Actor, BundlePort, ContextBundle, HistoryPort, ProjectionPort, RoomId, RoomPort } from '@photographic/core';
import {
  BUNDLE_TOKEN_BUDGET,
  RECENT_ACTIVITY_LIMIT,
  estimateTokens,
  openThreadsFor,
  recentActivityFor,
} from '@photographic/core';
import { renderInstructions } from '@photographic/agent';

export class PgBundle implements BundlePort {
  constructor(
    private readonly projection: ProjectionPort,
    private readonly rooms: RoomPort,
    private readonly history: HistoryPort,
  ) {}

  async build(
    actor: Actor,
    input: { activeRoomId?: RoomId; budgetTokens?: number } = {},
  ): Promise<ContextBundle> {
    const profile = await this.projection.getProfile(actor.personId);
    const rooms = await this.rooms.listForPerson(actor);
    const recent = await recentActivityFor(this.history, actor, RECENT_ACTIVITY_LIMIT);
    // Loose ends, from the same log through its own seam. See `openThreadsFor`.
    const open = await openThreadsFor(this.history, actor, new Date());

    const activeRoom = input.activeRoomId
      ? await this.projection.activeRoomContext(actor, input.activeRoomId)
      : null;

    const bundle: ContextBundle = {
      personId: actor.personId,
      profile,
      rooms,
      recent,
      open,
      activeRoom,
      budgetTokens: input.budgetTokens ?? BUNDLE_TOKEN_BUDGET,
      tokenCount: 0,
      bundleVersion: `${profile.version}.${rooms.length}.${activeRoom ? 1 : 0}.${recent.length}.${open.length}`,
      builtAt: new Date(),
    };

    bundle.tokenCount = estimateTokens(this.render(bundle));
    return bundle;
  }

  /**
   * Defaults to the budget the bundle was built against, not to a constant. See
   * `ContextBundle.budgetTokens`.
   */
  render(bundle: ContextBundle, budgetTokens = bundle.budgetTokens): string {
    return renderInstructions(bundle, { budgetTokens });
  }
}
