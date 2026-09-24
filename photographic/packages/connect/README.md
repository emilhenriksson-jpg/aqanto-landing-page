# @photographic/connect

Sign-up, and the flow that gets a person's AI connected. No UI here: this package is
pure logic plus route handlers, so the web app maps over data rather than encoding each
client's quirks in JSX.

The reasoning behind the shape of this is in `../../CONNECT.md`. The one thing to carry
in your head: **every person connects to the same URL**, `https://photographic.me/mcp`.
Identity arrives with the OAuth flow, never in the address. Nothing this package emits
is a secret.

## What the web app renders

```ts
import { buildClients, orderClients, detect, qrDataUrl } from '@photographic/connect';

const clients = orderClients(buildClients({ mcpUrl, connectPageUrl }), request.userAgent);
```

Or take the whole payload from `GET /v1/connect`, which is `buildClients` + `orderClients`
+ `detect` + a QR data URL already assembled:

```ts
interface ConnectPayload {
  mcpUrl: string;
  clients: ClientDescriptor[];
  detected: { platform: Platform; mobile: boolean; likelyClient: ClientId | null };
  qrDataUrl: string;
  headline: string;
}
```

Each card is one `ClientDescriptor`:

```ts
interface ClientDescriptor {
  id: 'cursor' | 'vscode' | 'claude-code' | 'claude' | 'chatgpt' | 'codex';
  displayName: string;
  agentClients: AgentClient[];
  capability: 'guaranteed' | 'deterministic' | 'best_effort' | 'manual';
  expectedDelivery: DeliveryMethod;
  oneClick: boolean;              // render the primary action as a big button
  primary: ConnectAction;         // deeplink | command | copy
  secondary: ConnectAction[];     // render small, under a "fler sätt" disclosure
  steps: string[];                // numbered list
  caveats: string[];              // render visibly, never behind a tooltip
  verifyPrompt: string;
  remedy: string;                 // only shown on verification timeout
}
```

`orderClients` guarantees it returns the same set, only reordered — a wrong guess must
never hide the right answer. `oneClick` is true only for Cursor and VS Code, the two
clients with a real install deeplink.

Render the current `caveats` in the open; do not invent additional capability claims.
ChatGPT phone Voice still needs a real tool-invocation test. Neither a text result
available to Voice nor a spoken refusal proves support or incompatibility. See
`../../docs/chatgpt-voice-verification.md`.

The ChatGPT card's second secondary action is a `copy` with an empty `value`: fill it
with the text from `GET /v1/context/rendered` so the button pastes the person's actual
profile.

## The verification step

Do not implement this as "config written, you are done". The whole point is to prove
context reached the model.

```
POST /v1/connect/verify   { clientId }        -> { handle, prompt }
GET  /v1/connect/status   { handle }          -> VerificationState
```

Show `prompt` — "Öppna Claude och fråga: **Vad vet du om mig?**" — and poll status every
two seconds. Then:

- `waiting` — keep the prompt up, show `remainingMs` as a quiet countdown
- `connected` — flip to green: "Claude anslöt 22:04 och läste din profil." If `degraded`
  is true, say the profile arrived but by a weaker route than this client supports
- `timed_out` — show `remedy`, which is written for that specific client. Never a
  generic error

The handle is plain JSON and survives a round trip to the browser, so status polling
needs no server-side state.

## Sign-up

```
POST /v1/signup/request  { email? phone? inviteToken? } -> { requestId, destinationHint, expiresAt }
POST /v1/signup/verify   { requestId, code }            -> { session, created, personalRoom, joinedRoom, next }
```

Passwordless. `next` is always `connect`, because account creation and connecting an AI
are one continuous flow rather than two chores.

An invited person passes `inviteToken` along with their email and comes out the other
side already in the room, with a personal room created silently. They never see a
separate signup step.

Codes are six digits, single-use, ten-minute TTL, five attempts, five requests per hour
per destination. Only an HMAC of the code is stored, and the destination is bound into
it so a code issued for one address cannot be replayed against another.

## Testing

`@photographic/connect/testing` exports `createHarness()` with in-memory doubles for
identity, invites, sessions, the code store and the sender. No database, no network, no
real clock:

```ts
const h = createHarness({ fixedCode: '424242' });
h.setNow(new Date(...));
h.sender.lastCode;
await h.sessions.simulateDelivery({ personId, agentClient: 'claude-desktop', method: 'mcp_instructions', at: h.now() });
```
