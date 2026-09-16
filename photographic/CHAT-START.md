# Room-independent conversation start

Implemented 2026-09-16. `/chatt` is the signed-in start on both hosts; the product
root redirects there. `/personligt` retains the personal-room screen. Phone login
without a return destination goes to `/chatt`.

Every new conversation requests `get_context` without a room, even when its MCP
connection predates another AI's writes. The bundle reserves a sample of recent
calendar activity and open threads alongside profile/compass and room overviews.
More timeline entries use spare space. Impossible budgets preserve safety rules
and compass over timeline content. Relevant room detail is fetched on demand.
Saving, provenance, isolation and shared-write approval use the existing ports.

## Launch capabilities and limits

Launch descriptors are separate from installation actions in `@photographic/connect`.
Prompts contain generic instructions only, never profiles, room ids, tokens or personal
endpoints. Identity stays in OAuth. First-time authorization is still necessary.

- Codex: `codex://threads/new?prompt=...`; new composer, no auto-send.
- Cursor: `cursor://anysphere.cursor-deeplink/prompt?text=...`; may reuse the current
  chat; web handoff available; no auto-send.
- Claude Desktop: `claude://claude.ai/new?q=...`; new composer, no auto-send.
  Web fallback opens a blank chat, with copyable start text on Photographic.
- ChatGPT: website plus an attempt to copy the generic start text. User pastes it
  and attaches Photographic from the tools menu. Clipboard denial exposes selectable
  text. We do not invent a published plugin id or connector-selection URL.

Desktop links require the corresponding app. Directory publication and provider
approval could reduce setup, but are not completed or claimed by this change.

Old deliveries cannot satisfy a new verification baseline. A new receipt says
“Ny kontext skickad till [client]”: evidence of delivery to a client, not proof a
particular model read it. Concurrent chats in one client are not individually
correlated. Opening an app, copying text and installing configuration never count.

## Official sources checked 2026-09-16

- https://learn.chatgpt.com/docs/reference/commands
- https://cursor.com/docs/reference/deeplinks.md
- https://support.claude.com/id/articles/14729294-buka-claude-desktop-dengan-tautan
- https://developers.openai.com/plugins/deploy/connect-chatgpt

## Verification

Tests cover launch encoding/privacy, clipboard denial, network retry, stale delivery,
fresh context over a reused MCP SDK connection, context budgets with full compass and
profile, and cross-client continuity with permissions and approval. The continuity
service test runs on memory and PostgreSQL in CI. These are protocol/application tests,
not claims of completed user OAuth and model runs inside all four commercial apps.

Chrome verified phone signup → `/chatt`, desktop/mobile layout, first-time setup
expansion, waiting-for-delivery state and personal-room/calendar navigation locally.
The full local unit run has an existing macOS unzip/Unicode failure in export; CI on
Linux is required before merge. No export implementation is changed here.
