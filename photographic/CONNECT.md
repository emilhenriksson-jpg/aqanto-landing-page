# Connecting an AI to Photographic

The onboarding path is the product. Someone who cannot connect their AI in under a
minute never finds out whether the memory is any good.

## The one decision everything else follows from

**Every person uses the same URL: `https://photographic.me/mcp`.**

Not `/mcp/emil`, not `/mcp/<token>`, not a per-user subdomain. Identity comes from
OAuth at connect time, never from the URL.

This is worth stating plainly because a per-user URL looks friendlier and is a trap:

- A URL containing a secret gets screenshotted, pasted into support threads, synced
  through cloud clipboards and typed into the wrong window. A URL that is safe to
  share publicly cannot be leaked.
- Revoking access must not mean changing an address the person has already configured
  in four clients. With OAuth you revoke a token and the URL keeps working.
- Room membership changes constantly. A token that resolves membership at request time
  stays correct; anything baked into a URL goes stale the moment someone leaves a room.
- One URL is memorable and speakable. A person can tell a colleague how to connect over
  the phone. That matters more than it sounds for something spreading through invites.

The cost is that the person must complete an OAuth flow. That is one extra click, and
it is the click that makes everything else safe.

## Sign-up

No passwords. Email or phone, one-time code, done. The person lands directly on the
connect screen — account creation and connecting an AI are one continuous flow, not two
separate chores.

An invited person skips even that: they arrive on the room preview, tap join, confirm a
code, and are in. Their personal room is created for them silently.

## Per-client connect

The connect screen detects the platform and leads with the right option, but shows all
of them. Each client below is a card with a single primary action.

### Cursor — genuinely one click

```
cursor://anysphere.cursor-deeplink/mcp/install?name=photographic&config=<base64>
```

where `<base64>` is the Base64 of exactly this, and nothing wrapping it:

```json
{ "type": "http", "url": "https://photographic.me/mcp" }
```

Encode only the transport config, not an outer `mcpServers` object — that is the
mistake everyone makes and it produces an invalid-JSON error in Cursor.

### VS Code and Copilot — one click

```
vscode:mcp/install?<url-encoded json>
```

with `{"name":"photographic","type":"http","url":"https://photographic.me/mcp"}`
JSON-stringified and then URL-encoded. Offer the Insiders variant
(`vscode-insiders:`) behind a small link.

### Claude Code — one command

```
claude mcp add --transport http photographic https://photographic.me/mcp
```

### Claude desktop, web and mobile — copy the URL

There is no install deeplink for Claude custom connectors, so this is a copy button
plus three steps: Customize → Connectors → Add custom connector, paste, authorise.

Say explicitly that it must be added from web or desktop first, because installing
connectors from mobile is still in beta — and then that it works in the mobile app
afterwards. Getting this wrong is the single most common support question we will get.

### ChatGPT — be honest about the limits

The private Photographic MCP app is connected through ChatGPT's settings and OAuth.
Per-conversation selection and the native startup path are documented in
`docs/chatgpt-start-verification.md`; use the current `ClientDescriptor` instructions.

Phone Voice tool invocation is not yet verified. A text tool result carried into a
voice conversation does not prove that Voice can make a fresh call. Equally, a spoken
claim that a tool is unavailable does not establish a server limitation. Do not promise
support or state a blanket incompatibility from either observation. See
`docs/chatgpt-voice-verification.md` for the evidence and acceptance test.

### Phone

A QR code that opens the connect page on the phone, for the case where the person is at
their laptop and wants Claude on mobile.

## The verification step

This is the part almost everyone in this category skips, and it is what makes the
difference between a person trusting the memory and quietly abandoning it.

After connecting, the page says:

> Öppna Claude och fråga: **"Vad vet du om mig?"**

and then it waits, live. The moment the MCP handshake arrives, the page turns green:

> Claude anslöt 22:04 och läste din profil.

If nothing arrives within a minute, it offers the specific fix for that client rather
than a generic error.

Implementation: the client session row records delivery already, so the connect page
polls `/v1/me/clients` (or subscribes over SSE) and reacts to the first delivery for a
client it has not seen before.

Never declare success on the basis of configuration having been written. Declare it
when context provably reached the model.

## After connecting

The client health screen keeps showing the truth for every connected AI: green when the
profile was delivered and by which channel, amber when it arrived only by a best-effort
route, red when it never landed.

We cannot force every client to read the personal room. Showing honestly which ones did
is the only promise we can actually keep, and it is more convincing than claiming
universal support.
