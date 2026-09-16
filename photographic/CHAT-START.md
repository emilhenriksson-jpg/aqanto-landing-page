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
- ChatGPT Desktop: `codex://threads/new?prompt=...`, the URL scheme retained by
  the current ChatGPT desktop app. Its installed macOS Info.plist also registers
  `codex`, not `chatgpt`. Opens a local composer; does not select a connector or send.
- ChatGPT iOS: associated `https://chatgpt.com/?q=...` Universal Link. Android:
  explicit HTTPS intent for verified package `com.openai.chatgpt`.
- Claude iOS: associated `https://claude.ai/new` Universal Link. Android: explicit
  HTTPS intent for verified package `com.anthropic.claude`. Mobile start text is
  copied for pasting; we do not substitute the separately documented Code routes.
- Codex and Cursor: no supported mobile launch for this flow; cards explain this
  and do not expose desktop chat links on phones. Setup instructions remain available.

The server selects links from the request platform. The web app uses the same central
resolver with browser touch information to handle iPad desktop-mode user agents.
App launches are direct user-click anchors in the same tab, preserving mobile app
handoff. There is no timer redirect or Android browser fallback. The browser option
is separate; ChatGPT uses its documented association exclusion `no_universal_links=1`.
OS preferences, app installation and browser restrictions can still prevent opening
an app. iOS Universal Links can stay on the web when disabled by the user; the UI
explains the long-press/app option. We cannot override those OS preferences.
Clipboard denial exposes selectable text. No published plugin id is invented.

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

- https://chatgpt.com/.well-known/apple-app-site-association
- https://chatgpt.com/.well-known/assetlinks.json
- https://claude.ai/.well-known/apple-app-site-association
- https://claude.ai/.well-known/assetlinks.json
- https://developer.chrome.com/docs/android/intents

## Native launch verification (2026-09-16)

Unit/component tests cover native Mac links, iOS/Android routes, iPad desktop mode,
explicit web alternatives, unavailable mobile clients, and clipboard/receipt behavior.
Physical mobile app handoff has not been tested here. Native ChatGPT UI verification
is unavailable: the computer-use tool denies control of `com.openai.codex` (the
installed ChatGPT desktop app). Its registration and official route docs were checked.

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
