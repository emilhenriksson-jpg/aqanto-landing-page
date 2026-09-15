# Web → REST against local Postgres (`VITE_USE_DEMO=0`)

Proves the non-demo path: migrate/seed Postgres, start REST with `DATABASE_URL`,
then walk signup → session → rooms → profile with the same `/v1/...` paths the web
client calls.

Default API origin matches `apps/web` (`DEFAULT_API_BASE`): `http://127.0.0.1:8787`.

## 0. Prep

```bash
cd photographic
pnpm install
export DATABASE_URL=postgres://photographic:photographic@127.0.0.1:5432/photographic
pnpm db:migrate
pnpm db:seed
# Seed person: emil@photographic.me (+ personal room + Buyersclub Ledning)
```

Start REST (foreground is fine; keep the log visible — the login code is printed there):

```bash
DATABASE_URL=postgres://photographic:photographic@127.0.0.1:5432/photographic \
  pnpm --filter @photographic/rest start
# or: pnpm dev
```

Expect a log line like `using_postgres` and `listening` on port `8787`.

## 1. Request login code

```bash
curl -sS -X POST http://127.0.0.1:8787/v1/signup/request \
  -H 'content-type: application/json' \
  -d '{"email":"emil@photographic.me"}'
```

Example body:

```json
{
  "requestId": "<uuid>",
  "channel": "email",
  "destinationHint": "e***@photographic.me",
  "expiresAt": "..."
}
```

In development there is no mailer. The REST process logs the code:

```text
{"level":"warn","msg":"signup_code","channel":"email","code":"100002",...}
```

Copy `requestId` from the response and `code` from that log line.

## 2. Session (verify code)

There is no separate `GET /session`. The browser session token is minted here — same
shape onboarding stores as `photographic_session` and the web `apiFetch` sends as
`Authorization: Bearer …`.

```bash
curl -sS -X POST http://127.0.0.1:8787/v1/signup/verify \
  -H 'content-type: application/json' \
  -d '{"requestId":"<requestId>","code":"<code from signup_code log>"}'
```

Take `session.token` from the JSON (looks like `session-<personId>-<n>`).

```bash
export TOKEN='session-…'
```

## 3. List rooms

Web client: `listRooms()` → `GET /v1/rooms`.

```bash
curl -sS http://127.0.0.1:8787/v1/rooms \
  -H "authorization: Bearer $TOKEN"
```

For the seeded Emil account you should see the personal room and
`Buyersclub Ledning` (`kind: "shared"`).

## 4. Get profile

Web client: `getProfile()` → `GET /v1/profile`.

```bash
curl -sS http://127.0.0.1:8787/v1/profile \
  -H "authorization: Bearer $TOKEN"
```

Seeded profile includes identity / hardFacts / instructions (ketchup allergy, etc.).
This is the curl that proves profile read against Postgres.

## Optional: one room

Web client: `getRoom(roomId)` → `GET /v1/rooms/:roomId`.

```bash
curl -sS "http://127.0.0.1:8787/v1/rooms/<roomId>" \
  -H "authorization: Bearer $TOKEN"
```

## Web app against the same API

```bash
# apps/web — live API, not demo fixtures
VITE_USE_DEMO=0 VITE_API_BASE=http://127.0.0.1:8787 pnpm --filter @photographic/web dev
```

Put the session token in the browser (DevTools → Application → Local Storage):

| key                   | value        |
| --------------------- | ------------ |
| `photographic_session` | `$TOKEN` from step 2 |

## Path checklist (web client ↔ REST)

| Web (`apps/web/src/api`) | REST |
| ------------------------ | ---- |
| `getProfile` → `/v1/profile` | `GET /v1/profile` |
| `listRooms` → `/v1/rooms` | `GET /v1/rooms` |
| `getRoom` → `/v1/rooms/:id` | `GET /v1/rooms/:roomId` |
| `getInvite` → `/v1/invites/:token` | `GET /v1/invites/:token` |
| `forgetMemory` → `DELETE /v1/memory/:shortId` | `DELETE /v1/memory/:shortId` |
| `undoMemory` → `POST /v1/memory/undo` | `POST /v1/memory/undo` |

Signup lives in the onboarding app (`POST /v1/signup/request`, `POST /v1/signup/verify`),
not in the room UI client — use the curls above (or onboarding) to mint a token.
