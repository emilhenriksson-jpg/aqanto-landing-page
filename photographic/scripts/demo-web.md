# Web app against live REST (`VITE_USE_DEMO=0`)

Short path to run the room UI against Postgres instead of demo fixtures.

## 1. REST + seed

Follow `scripts/demo-api.md` §§0–2: migrate/seed, start REST with `DATABASE_URL`,
request a login code, verify, and export `TOKEN` from `session.token`.

```bash
cd photographic
export DATABASE_URL=postgres://photographic:photographic@127.0.0.1:5432/photographic
pnpm db:migrate && pnpm db:seed
DATABASE_URL=… pnpm --filter @photographic/rest start
# then the signup request/verify curls in demo-api.md
```

## 2. Start the web app (live)

```bash
VITE_USE_DEMO=0 pnpm --filter @photographic/web dev
```

Optional: `VITE_API_BASE=http://127.0.0.1:8787` (that is already the default).

## 3. Session in the browser

DevTools → Application → Local Storage on the Vite origin:

| key                    | value                          |
| ---------------------- | ------------------------------ |
| `photographic_session` | `$TOKEN` from demo-api.md §2 |

Rooms, personal room, shared rooms, Klienter, and Godkänn then call `/v1/...`
via `useRoomData` + `load*FromApi`. Curl proofs for rooms/profile stay in
`scripts/demo-api.md`.
