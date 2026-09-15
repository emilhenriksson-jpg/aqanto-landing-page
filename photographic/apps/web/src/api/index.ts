export { ApiError, apiFetch } from './client.js';
export { listClients } from './clients.js';
export {
  DEFAULT_API_BASE,
  SESSION_STORAGE_KEY,
  apiBase,
  getSessionToken,
  isDemoMode,
} from './config.js';
export { getInvite } from './invites.js';
export { listHistory } from './history.js';
export { forgetMemory, undoMemory } from './memory.js';
export { getProfile } from './profile.js';
export { listProposals, resolveProposal } from './proposals.js';
export { getRoom, listRoomDocuments, listRoomItems, listRooms } from './rooms.js';
export { askMemory } from './search.js';
export type { AskMemoryInput } from './search.js';
export { listTrash, restoreTrash } from './trash.js';
export type {
  AskHitDto,
  BriefDto,
  ClientHealthDto,
  ForgetResponse,
  HistoryEntryDto,
  InvitePreviewDto,
  ItemDto,
  ProfileDto,
  ProfileSectionsDto,
  ProposalDto,
  RenderedItemDto,
  RoomDocumentDto,
  RoomDto,
  RoomItemDto,
  RoomMemberDto,
  RoomSummaryDto,
  TrashEntryDto,
} from './types.js';
