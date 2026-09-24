# ChatGPT phone Voice investigation — 2026-09-24

## Status and evidence

Emil confirmed that the failing test used **the ChatGPT app on his phone**.
The phone OS and app version were not established. Do not substitute desktop
Live, the Realtime API, or a synthetic MCP client for this acceptance surface.

Read-only inspection of the actual conversation, “Hälsning Tja”, showed:

- Voice greeted the person and denied having Photographic access. No associated
  tool call was visible.
- The typed message “Hej! Jag kommer från Photographic.” produced a real
  `get_context` call and a profile/room response. Its tool-call detail was inspected.
- Subsequent voice turns discussed that returned context. The request to create a
  room produced a spoken refusal, with no visible `create_room` attempt.

Conversation: https://chatgpt.com/c/6ab4f163-6950-83eb-b7a7-2a59becb4f4e

This proves text retrieval in that conversation. It does not prove a new tool call
during active Voice, delayed synchronization, or that every tool reached the voice
model. The model's availability claims are not capability evidence. A claimed
23 September Voice/plugin rollout in the transcript was not verified in the
official documentation consulted; do not treat it as a confirmed release.

Bounded production-log inspection found context reads but no retained room-creation
call corresponding to the reported refusal. Retention and absent modality markers
prevent a definitive historical diagnosis. The leading hypothesis is a difference
in client-side discovery, selection or invocation between text and Voice; this is
not yet established as the root cause.

## Answers to the handoff's ten questions

| Question | Verified implementation / remaining limit |
| --- | --- |
| Registration | The existing private MCP app uses OAuth and the shared `https://mcp.photographic.space/mcp` endpoint. `initialize` supplies instructions; `tools/list` supplies the centralized `@photographic/agent` definitions. |
| Tools in Voice | Photographic has no voice filter. Full authorization offers all 12 tools. What the phone host presents to its voice model remains unverified. `create_room` needs `rooms.read` and `memory.write`; `get_context` needs only `profile.read`. Reading alone cannot prove write authorization. |
| Automatic startup | Initialize builds a profile/context bundle and sends instructions. It does **not** run `get_context`. The host must follow the startup guidance and invoke tools; no Voice-start event reaches this server. A bare spoken greeting is not yet a verified trigger. |
| Text → Voice | The observed voice turns could discuss the preceding text tool result. No new Voice tool invocation was verified. An existing transport can be reused, so there need not be another initialize or tools/list. |
| Voice → text | The typed startup message in the reported conversation did invoke `get_context`. This proves that call, not all transitions or automatic recovery. |
| Different instructions | Photographic sends the same shared instructions, adapted to person/context. There is no Live-specific instruction variant. Which instructions the host supplies to each model is outside server visibility. |
| Read but no create | A prior text result can be present without a fresh Voice call. Narrower scopes are another possible cause. The old trace was insufficient to decide; new traces distinguish offered tools, incoming calls and responses. |
| Tool descriptions | The centralized definitions already include explicit create/read/save triggers and permissions. A server-side wording change cannot make an absent host tool available. Scope refusals now identify missing permissions without implying a Voice incompatibility. |
| Voice configuration | No Voice-enable flag was found in the official MCP/plugin contract consulted. This is not proof that all phone versions support invocation. Desktop Live/Remote documentation does not settle ordinary phone Voice behavior. |
| Automated regression | The real SDK/HTTP transport test checks all 12 tools, context, creation, reviewed approval, save/readback, reuse/reconnect and authorization changes. It cannot automatically detect that ChatGPT's phone voice model lost tools. The device acceptance test below is still required. |

## Fix and diagnostics

Deployed `6870a06` after full CI run [35985545247](https://github.com/emilhenriksson-jpg/aqanto-landing-page/actions/runs/35985545247)
passed. Production health reported Postgres healthy. A read-only call through the
existing connected Codex plugin succeeded at 10:13:50 UTC on 24 September; the new
request and `ok` response shared a call ID and audit-session ID (92 ms server time).
No `tools/list` event accompanied that read, consistent with a cached host catalogue;
this live check proves request/response tracing, not rediscovery or phone Voice.

An MCP connection previously captured permissions at initialization and, on later
requests, checked only the person's identity. It now also binds the OAuth client,
scopes and room scope. Changed authorization returns 404 and requires a fresh
initialize/discovery. Equivalent token refreshes continue to work. This fixes a
real stale-permission/catalog bug; it is **not a demonstrated cause** of this phone
incident.

New structured trace events:

- `tools_listed`: canonical tool names/count actually offered for that connection.
- `tool_requested`: a server-generated call ID and canonical tool name.
- `tool_response`: matching call ID, duration and `ok`, `error` or `scope_denied`.
- `session_authorization_changed`: requires a fresh connection.

Session traces include an internal audit-session ID and normalized client label.
They add no prompts, audio, tool arguments/results, credentials, raw client names
or MCP transport-session IDs. Unknown tool names are recorded as `unknown`.
The current `chatgpt-web` label is a historical normalization for any OpenAI/ChatGPT
client name: **it does not prove web, desktop, phone, text or voice**. Record the
user's surface and test time separately. Do not infer modality from this label.

`tools_listed` proves an offered catalogue, not model delivery. `tool_response: ok`
means a successful tool response, not necessarily a committed memory: proposal
creation and individual `not_applied` approval results can also return normally.
Inspect the user-visible result and read back the saved memory before claiming a
write succeeded. Correlate concurrent requests by call ID and audit-session ID.

## Current approval behavior

The transport test found a separate UX limitation: `create_room` creates an
owner-only project room, represented internally by the shared-room kind. Current
write policy therefore queues `remember` for approval even with `explicit: true`.
The test asserts it is **not saved yet**, obtains the exact `review_proposals`
preview, simulates the person's explicit approval, then checks saved status and
readback. Approval stays in chat; opening Photographic is not required for a
private proposal.

The ideal five-utterance test is therefore not currently guaranteed, independently
of Voice availability. Do not bypass the shared-room write policy to make that
test green. Removing a redundant approval for owner-only project rooms requires
an explicit policy change with atomic audience checks in both persistence drivers.

## Physical phone acceptance test — still pending

Use the connected phone account; record app version, OS, local time/timezone,
whether this is a new/existing conversation and whether Photographic is selected.
No logout or reconnection is needed unless the trace shows an authorization issue.

1. Start a new Voice conversation and say “Hej.” Check for an actual context call;
   do not count a familiar greeting or availability statement as success.
2. Say “Vilka rum har jag?” Verify the returned room names against live data.
3. Say “Skapa ett nytt rum som heter Test Voice.” Require an actual `create_room`
   request and successful result. Do not accept “jag kan skapa det” as completion.
4. Say “Kom ihåg i det rummet att Voice-testet fungerade.” If the response is a
   proposal, hear the preview and approve it in Voice. Require successful approval.
5. Say “Vad sparade vi precis?” Require a fresh read and the saved text.
6. Switch to text, read that room, switch back to Voice and read it again. Repeat
   with an existing conversation to check reuse. Keep any provider approval prompts.

Leave the test room in place unless the person authorizes deletion. If the first
step fails, record it as a failure even if later explicit requests work. Success
requires the complete flow without leaving Voice for a Photographic page, plus
the transition checks; a simulated client cannot establish that.

Diagnosis from a fresh bounded log window:

| Trace and visible result | Interpretation / next step |
| --- | --- |
| Full list offered, spoken refusal, no incoming call | Photographic did not receive the action. Investigate host activation/model routing; offering a list alone does not prove Voice saw it. |
| Catalogue missing create/write, or `scope_denied` | Inspect that connection's authorized scopes; reconnect with the needed permissions. |
| `session_authorization_changed` | Host must initialize again with its current grant. |
| Incoming call with error | Investigate that server error using the call ID; do not blame modality. |
| Successful response but no committed memory | Check for proposal, approval failure or duplicate result; read back before declaring success. |
| Committed action/readback succeeds but Voice denies it | Investigate delivery of the tool result and client/model interpretation. |

## Official sources consulted

- https://developers.openai.com/plugins/build/mcp-server — shared MCP definitions,
  server instructions and annotations; no Voice-enable flag established here.
- https://learn.chatgpt.com/docs/features/voice — desktop Live and iOS Remote
  paired to a desktop host; not evidence of this phone test's tool invocation.
- https://learn.chatgpt.com/docs/plugins — general plugin surfaces and tools;
  does not establish the complete phone Voice acceptance chain above.
