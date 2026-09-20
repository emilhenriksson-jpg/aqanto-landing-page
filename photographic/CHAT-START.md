# Room-independent conversation start

Implemented 2026-09-16. `/chatt` is the signed-in start on both hosts; the product
root redirects there. `/personligt` retains the personal-room screen. Phone login
without a return destination goes to `/chatt`.

Once Photographic is enabled in a conversation, its instructions ask the model to
request `get_context` without a room, even when its MCP connection predates another
AI's writes. A launch link alone does not supply those instructions. The bundle reserves a sample of recent
calendar activity and open threads alongside profile/compass and room overviews.
More timeline entries use spare space. Impossible budgets preserve safety rules
and compass over timeline content. Relevant room detail is fetched on demand.
Saving, provenance, isolation and shared-write approval use the existing ports.

## A calmer return (2026-09-19)

The home greets the actual account name and remembers only the last chosen client on
this device. Supported mobile clients come before desktop-only options. Account and
receipt reads cannot block the launch list. A remembered click never counts as memory delivery. The 2026-09-20 correction below
moves setup and connection evidence out of the nested help.

Conversation guidance now favours warmth and optional curiosity: one question at a time,
listen before advice, stop after a short answer or topic change, and avoid inventing a
mood, local time or a completed plan. The current request comes before memory import;
comparison happens at a natural pause, before new onboarding questions. Custom compass
principles remain intact. See `docs/conversation-experience.md` for acceptance cases.

## Launch capabilities and limits

Launch descriptors are separate from installation actions in `@photographic/connect`.
Behavioral instructions travel through the MCP connection, not a user-authored launch
message. The optional greeting is just “Hej! Jag kommer från Photographic.” It never
contains profiles, room ids, tokens or personal endpoints. Identity stays in OAuth.
First-time authorization is still necessary.

- Codex: `codex://threads/new?mode=codex`; empty Codex composer,
  no auto-send.
- Cursor: `cursor://anysphere.cursor-deeplink/prompt?text=...`; short greeting, may
  reuse the current chat; web handoff available; no auto-send.
- Claude Desktop: `claude://claude.ai/new`; empty composer, no auto-send.
  Web fallback also opens a blank chat.
- ChatGPT Desktop: `codex://threads/new?mode=chat`, the URL scheme retained by
  the current ChatGPT desktop app. Its installed macOS Info.plist also registers
  `codex`, not `chatgpt`. Explicitly selects Chat mode for a new ordinary ChatGPT
  conversation; does not select a project or connector, or send a prompt.
- ChatGPT iOS: associated `https://chatgpt.com/?q=...` Universal Link with the short
  greeting, preserving the verified mobile association rather than guessing an empty route. Android:
  explicit HTTPS intent for verified package `com.openai.chatgpt`.
- Claude iOS: associated `https://claude.ai/new` Universal Link. Android: explicit
  HTTPS intent for verified package `com.anthropic.claude`. Empty composer; no automatic
  clipboard writes. We do not substitute the separately documented Code routes.
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
The connection section offers an explicit Photographic retrieval question. Copying
requires a button click; clipboard denial exposes selectable text. A greeting alone
cannot enable the connector. No published plugin id is invented.

Desktop links require the corresponding app. Directory publication and provider
approval could reduce setup, but are not completed or claimed by this change.

Old deliveries cannot satisfy a new verification baseline. A new receipt says
that the client retrieved memory, explicitly noting that the individual chat cannot
be identified. This is delivery evidence, not proof a particular model read it. Concurrent chats in one client are not individually
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

## Quiet personal greeting (2026-09-19)

MCP initialization and `get_context` carry the first-response guidance. The AI reads
fresh context before a personal greeting, uses only a confirmed name, and does not
repeat the introduction when the person already has a request. It reads quietly and avoids a repeated connection ritual; it must not claim a click/arrival source
without a signal, or claim to know the person before a successful read.

An empty profile overview is not proof that every room is empty or the account is
new. Empty profiles invite relevant available-context suggestions; comparison results
with new facts show up to three examples and link to the complete private review.
No additions, pause or an existing pending review means no repeated offer. A fetch
failure gets a short connection explanation, never a fabricated empty-memory onboarding.

**Unresolved provider boundary:** initialization supplies guidance; it does not start
a model turn. No supported auto-send or per-chat connector-activation mechanism has
been verified for these launch links. The person still starts speaking/typing (or
sends the short greeting in Cursor/ChatGPT mobile) and ChatGPT may require selecting
the connection. An API-backed conversation owned by Photographic would give control
of a first assistant turn but would not inherit a native client's private memories.
Neither that architecture change nor a fully automatic native greeting is claimed.

Protocol/UI tests cover background instruction delivery, empty/failure distinction,
instruction budgets, blank desktop links, mobile routes and explicit-only clipboard use.
Native client model responses remain unverified. To evaluate them, use separate test
accounts covering: known name; empty profile with/without client memories; full profile
with novel facts; shared-room data with an empty profile; paused/pending offers; failed
context reads; and a direct user request that should skip the greeting ritual.

## Native launch verification (2026-09-16)

Unit/component tests cover native Mac links, iOS/Android routes, iPad desktop mode,
explicit web alternatives, unavailable mobile clients, and clipboard/receipt behavior.
Physical mobile app handoff has not been tested here. Native ChatGPT UI verification
is unavailable: the computer-use tool denies control of `com.openai.codex` (the
installed ChatGPT desktop app). Its registration and official route docs were checked.

### Chat mode correction (2026-09-19)

The earlier desktop ChatGPT link omitted `mode`, so it could retain Codex mode and
offer a task in the current local project. Both desktop buttons now specify their
mode (`chat` or `codex`); neither includes `projectId`, `path` or `originUrl`.
The official commands page documents the retained scheme and local new-thread
route, but not the mode parameter. Read-only inspection of the installed macOS
ChatGPT 26.908.70816 confirms that the parser accepts `chat | work | codex`, passes
the chosen mode to the new-thread route, and the renderer selects that mode.
Without a project id, path or origin, the native route supplies no project.
Regression tests distinguish both buttons on desktop and preserve mobile routes.
This is route/code verification, not a completed native UI handoff test; the
computer-use restriction above still applies.

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

## Connection gap correction (2026-09-20)

A real ChatGPT conversation opened from `/chatt` answered from its own memory and
reported no Photographic connection. The signed-in Photographic account also showed
no connected AIs. The launch routes were working; connector activation was absent.

The home now exposes absence/error/history and first-time setup directly on each
card. ChatGPT explicitly says to select Photographic in the new chat. The connection
check asks for a fresh Photographic tool read, not an answer the provider could give
from its own memory. Historical receipts never say the next chat is connected.

Official docs describe a native `codex://new?prompt=...` with a `plugin://` mention,
but only for an actual available plugin identity. Photographic was not found in the
plugin directory. A registered ChatGPT MCP app ID and an installed/available plugin
are still needed before that route can be implemented and tested honestly. A local
MCP configuration is not evidence that a regular ChatGPT chat has the same access.

The authenticated ChatGPT setup and native model/tool run remain unverified. Chrome
is signed out of ChatGPT; the user must sign in before that account can be inspected.
No invented plugin ID, automatic data access, or completed native connection is claimed.

Sources checked: https://developers.openai.com/plugins/deploy/connect-chatgpt,
https://learn.chatgpt.com/docs/reference/commands,
https://developers.openai.com/plugins/build/plugins.

## Fewer clicks to a working connection (2026-09-20)

The initial primary action now connects an unverified client instead of opening a
blank chat first. One click opens the provider's supported setup destination and
expands the guide in Photographic. For ChatGPT, Claude and Codex, the visible hint
explicitly explains that this also copies the public MCP address; no memory or
credential is copied. Clipboard denial shows selectable text. Cursor receives its
existing prepared install link. Codex's main guide uses app settings, keeping the
terminal alternative in extra help.

Existing, non-revoked profile-delivery evidence retains direct native launch. An
unknown/error state does not pretend the client is unconfigured or force reinstall.
Someone who already installed a connector can open the chat from the guide and
request memory without installing again. No room selection is added.

Verification starts with the setup click and retains the original baseline for ten
minutes, allowing time for sign-in and consent. Chat launches use the existing shorter
window. Focus/visibility return checks immediately; duplicate clicks and overlapping
polls are coalesced. Network retry keeps the baseline, and page teardown aborts work.
Account receipt history refreshes on return, keeping the previous result visible so
the primary action cannot briefly change from Connect to Open during that refresh.
A success is still client-level delivery
evidence, not proof of an individual chat or silent tool activation.

Limits: these changes shorten the supported manual connection path. ChatGPT still
needs account/workspace support for custom plugins and selection in the conversation.
No registered or published Photographic plugin is available to attach in a deep link.
The first native model reply and physical mobile handoff still require end-to-end
provider testing. The UI tests and browser layout verification do not establish them.

Validation: web 150 tests, connect 149 tests, relevant typechecks and lint; Chrome
setup-click/clipboard/destination check and 320px CSS-width guide with no overflow or
console errors. No settings, connector grants or native chats were submitted in the
provider apps during this verification.

Official setup sources checked:
- https://learn.chatgpt.com/docs/extend/mcp
- https://learn.chatgpt.com/docs/reference/commands
- https://developers.openai.com/plugins/deploy/connect-chatgpt
- https://support.claude.com/en/articles/11176164-use-connectors-to-extend-claude-s-capabilities
- https://prod.cursor.com/docs/mcp/install-links
