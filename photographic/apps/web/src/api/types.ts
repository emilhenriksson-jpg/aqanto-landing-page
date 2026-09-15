/** Wire shapes from `apps/rest` serialisers — only the fields the room UI needs. */

export interface RoomSummaryDto {
  roomId: string;
  slug: string;
  title: string;
  kind: 'personal' | 'shared';
  role: string;
  oneLine: string;
  memberCount: number;
  unseenCount: number;
}

export interface RoomDto {
  id: string;
  kind: 'personal' | 'shared';
  slug: string;
  title: string;
  description: string | null;
  createdAt: string;
  archivedAt: string | null;
}

export interface BriefDto {
  roomId: string;
  rendered: string;
  tokenCount: number;
  stale: boolean;
  builtAt: string;
}

export interface RoomMemberDto {
  personId: string;
  displayName: string | null;
  role: string;
}

/** GET /v1/rooms/:id/items — active memories for the shared-room screen. */
export interface RoomItemDto {
  shortId: string;
  kind: string;
  body: string;
}

export interface RenderedItemDto {
  shortId: string;
  body: string;
}

export interface ProfileSectionsDto {
  identity: RenderedItemDto[];
  hardFacts: RenderedItemDto[];
  preferences: RenderedItemDto[];
  instructions: RenderedItemDto[];
  never: RenderedItemDto[];
  currentFocus: RenderedItemDto[];
}

export interface ProfileDto {
  rendered: string;
  sections: ProfileSectionsDto;
  tokenCount: number;
  itemCount: number;
  version: number;
  builtAt: string;
}

export interface ItemDto {
  shortId: string;
  roomId: string;
  kind: string;
  body: string;
  status: string;
}

export interface ForgetResponse {
  item: ItemDto;
  undoToken: string;
  daysRecoverable: number;
}

/** Public GET /v1/invites/:token — no auth, harder rate limit. */
export interface InvitePreviewDto {
  room: { title: string; description: string | null };
  invitedByName: string | null;
  /** Newline-separated memory bodies, capped server-side. */
  preview: string | null;
  role: string;
  expiresAt: string;
}

/** GET /v1/clients — per-AI delivery lights. */
export interface ClientHealthDto {
  agentClient: string;
  displayName: string;
  lastSeenAt: string;
  profileDelivered: boolean;
  deliveryMethod: string | null;
  degraded: boolean;
}

/** GET /v1/memory/proposals — pending approval cards. */
export interface ProposalDto {
  id: string;
  roomId: string;
  kind: string;
  body: string;
  reason: string;
  proposedByClient: string | null;
  createdAt: string;
}

/** GET /v1/trash — soft-deleted memories still recoverable. */
export interface TrashEntryDto {
  shortId: string;
  roomId: string;
  roomTitle: string;
  kind: string;
  body: string;
  deletedAt: string;
  deletedByClient: string | null;
  deleteReason: string | null;
  purgeAfter: string;
  daysRemaining: number;
}
