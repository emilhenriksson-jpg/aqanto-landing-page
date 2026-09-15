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
