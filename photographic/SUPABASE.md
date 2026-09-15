# Supabase

Supabase is **Postgres + Auth + Storage**. It is not the authorization engine.

That sentence is the whole design. Room permissions live in the API layer — one place,
testable, portable — and no row-level security policy is installed to duplicate them.
Two authorities on who may read a room is how rooms leak, and a permission model living
in a vendor's policy engine is a permission model that cannot be moved. This is
build-plan decision 4, and it is also what makes "the architecture can be swapped"
something we can demonstrate rather than assert.

Every line of Supabase-specific code in the product is in `packages/supabase`. If you
ever need to leave, that is the folder to read.

## Nothing here is required

A missing Supabase configuration is a normal state, not an error. Without
`SUPABASE_URL`, the process runs against local Postgres and local disk, and the ports
mean it does not care. `pnpm dev` works with none of this set.

## The three capabilities, which are independent

### 1. Postgres — a re-point, not a rewrite

Point `DATABASE_URL` at the project. That is all: the migrations in `packages/db`
apply unchanged, `pnpm db:seed` works, and both e2e suites pass.

**Use the session-mode pooler on port 5432, for everything.** One string, for the
migration and for the app:

```bash
DATABASE_URL='postgres://postgres.PROJECT:PW@aws-0-REGION.pooler.supabase.com:5432/postgres'
```

That is a change from what this file used to say, and the old advice — direct connection
on 5432 for migrations, transaction pooler on 6543 for the app — cannot be followed as
written. The Dockerfile runs `pnpm db:migrate` and then the server from **one**
environment, so there is one `DATABASE_URL` and it has to serve both. The session pooler
is the string that can:

| | Port | DDL safe | Prepared statements | Reachable from |
|---|---|---|---|---|
| Direct | 5432 | yes | yes | **IPv6 only** — a Fly machine, but not most CI |
| **Session pooler** | **5432** | **yes** | **yes** | **IPv4, anywhere** |
| Transaction pooler | 6543 | no | **no** | IPv4, anywhere |

It is a real session, so DDL is safe. It is port 5432, so `supabasePoolConfig` does not
take its transaction-pooler branch and prepared statements stay on. And it is IPv4, so
the same secret works from Fly, from CI and from a laptop — the direct connection is
IPv6-only on the Free and Pro plans, which works from a Fly machine and not from most
other places.

#### TLS: verified, with the CA shipped in the image

Supabase's Postgres certificate chain terminates at **`Supabase Root 2021 CA`**, a
private root in no system trust store. Node rejects it with `self-signed certificate in
certificate chain`.

**This needs no configuration.** That root ships in `packages/db/certs/`, and
`resolveDatabaseTls` uses it for any non-loopback host. A public root certificate is not
a secret, and bundling one is what every runtime does with its trust store — shipping it
means the first deploy is verified without a secret that, when forgotten, fails the
container before it serves anything.

To override — a different project CA, or a rotation before we ship a new one:

```bash
export SUPABASE_CA_CERT="$(cat prod-ca-2021.crt)"   # the whole PEM block
export SUPABASE_CA_CERT_FILE=/run/secrets/ca.crt    # or a path
```

**Do not put `sslmode` in the URL.** This is the part that wastes an afternoon, and it is
measured against the live project rather than inferred:

| `DATABASE_URL` suffix | What `pg` does |
|---|---|
| *(none)* | TLS with the bundled CA, **verified**. Use this. |
| `?sslmode=require` | Treated as `verify-full` against the *system* store → fails. And the presence of `sslmode` makes an explicit `ssl` option be **discarded**, so passing the CA does not help. Refused at boot with instructions. |
| `?sslmode=no-verify` | Encrypted but unauthenticated. Refused: for a database holding people's private memory that is the wrong trade even as a stopgap, and there is a verified alternative for free. |
| `?sslmode=verify-full&sslrootcert=…` | Works. `pg` reads the CA from the URL and `resolveDatabaseTls` steps aside. |

`sslmode=require` is what Supabase's own docs tell you to write, which is why this table
exists. `pg` treats `require` as an alias for `verify-full` — the library says so in a
deprecation warning — not as libpq's encrypt-but-don't-verify.

One consequence worth stating plainly: with no `sslmode` **and** no `ssl` option, `pg`
connects in **plaintext**, and Supabase's pooler accepts it. So `resolveDatabaseTls`
refuses a remote host it has no CA for rather than falling through — a fix that merely
stopped erroring could have handed this database an unencrypted connection nobody would
notice.

Both code paths go through `createPool`, which is the point. The migration runner used to
build a bare `new Pool({ connectionString })` that never read the CA, while only the app
composed one — and the Dockerfile runs the migration first, so the path with no CA was
the first thing to run.

#### The transaction pooler

Port `6543` is pgBouncer in transaction mode and does not support prepared statements,
which `pg` uses for every parameterised query. The symptom is that everything works under
light load and then fails with `prepared statement "..." already exists` once two
requests share a backend. Detected automatically by `supabasePoolConfig`, which logs the
mode it chose — this is a load-dependent failure no test will catch.

Do not use it for this app. The session pooler above is the right choice and the table
explains why.

### 2. Storage — behind a port, so it can be replaced

`SupabaseStorageBlobStore` implements `BlobStore` from `@photographic/documents`,
alongside `LocalBlobStore` and `S3BlobStore`. The memory model never learns which one is
installed, so moving document originals to Cloudflare R2 later is a branch in
`resolveBlobStore` and nothing else.

```bash
export SUPABASE_URL=https://PROJECT.supabase.co
export SUPABASE_SERVICE_ROLE_KEY=...        # root credential for the project
export SUPABASE_STORAGE_BUCKET=documents    # private; create it yourself
```

Create the bucket as **private**. Nothing in this codebase ever makes a public URL; the
export download link is a signed URL with an expiry, which is a capability that runs
out rather than one handed to anyone who learns a checksum.

Keys are content-addressed — `sha256/ab/cd/<checksum>` — so the same file uploaded twice
occupies one object and a retried upload is idempotent. That matters more than it
sounds: the retry path for a 40 MB PDF on a phone is a second upload of the same file.

Uploads use the service role key rather than the person's token. Photographic has
already decided, in its own API layer, whether this person may write to this room;
handing Supabase a user token and letting it decide would be the RLS duplication above.

To use R2 or any S3-compatible store instead, set these and Supabase Storage is ignored:

```bash
export BLOB_S3_BASE_URL=https://ACCOUNT.r2.cloudflarestorage.com/photographic
export BLOB_S3_ACCESS_KEY_ID=...
export BLOB_S3_SECRET_ACCESS_KEY=...
export BLOB_S3_REGION=auto
```

### 3. Auth — identity, and only identity

`SupabaseAuth` verifies a Supabase access token and maps its subject to a Photographic
`PersonId`. It answers "is this person who they say they are". It does not answer "may
this person read this room", and it is not given the chance to.

```bash
export SUPABASE_URL=https://PROJECT.supabase.co
# Only for a project still issuing HS256 tokens. New projects use asymmetric keys and
# need nothing here — verification then uses the public JWKS, so this process holds no
# credential that could mint a token for any user in the project.
export SUPABASE_JWT_SECRET=...
```

Both `iss` and `aud` are checked. Skipping the audience would let a token minted
elsewhere in the same project — a service token, say — authenticate as a person.

**No `person_id` is ever read from a token's claims.** A Supabase project's user
metadata is writable through its own Auth API, so a `person_id` claim would be an
identity a person could choose. The mapping lives in `app.credential`, keyed on the
provider subject, and is ours.

Account linking has one rule worth knowing: an unknown subject adopts an existing
Photographic account **only when Supabase says the email is verified**. Otherwise it
gets a new account. Linking on an unverified address would be an account takeover in one
step — sign up claiming someone else's email, inherit their memory. A duplicate account
for someone who has not confirmed their address yet is recoverable; that is not.

## Checking a deployment

The process says what it found at boot:

```
{"msg":"database_tls","detail":"TLS verifieras mot det medföljande Supabase-rotcertifikatet."}
{"msg":"oauth_persistence","kind":"postgres"}
{"msg":"blob_storage","kind":"supabase"}
{"msg":"supabase","storage":true,"auth":true}
```

`database_tls` is the line to read first on a deploy: it says which CA is in use and
therefore whether the connection is verified. `supabase_incomplete` warnings name exactly
what is missing, in Swedish. A project configured for Postgres but not Storage is a
normal state and logs a warning rather than refusing to boot — but an operator should
know before someone uploads a file.

The failure that looks like success: if `DATABASE_URL` did not work the process does not
crash, it logs `{"msg":"oauth_persistence","kind":"memory"}` and serves an in-memory
implementation that looks entirely healthy and forgets everything on restart. Check that
line says `postgres`.

### Verifying TLS without credentials

A TLS handshake happens before authentication, so a deliberately wrong password is enough
to tell a certificate problem from a login problem — which makes this checkable from any
machine, against the real project:

```bash
LIVE_SUPABASE=1 LIVE_SUPABASE_HOST=aws-0-REGION.pooler.supabase.com \
  pnpm --filter @photographic/db exec vitest run src/tls.test.ts
```

`tenant/user … not found` means the handshake verified. `self-signed certificate in
certificate chain` means it did not. A local Postgres has none of this behaviour, which
is why these two tests are the only ones in the repo that talk to the real thing.

## Current status

Everything above is built and tested. `packages/supabase` has 35 tests: tokens are
minted with a real key pair and verified through the real `jose` path, and Storage runs
against an injected `fetch` that answers like the Storage API does, including the 409
that is its deduplication signal.

**The TLS path is verified against the real project** (Frankfurt, `eu-central-1`). Read
its certificate chain — leaf `*.pooler.supabase.com` → `Supabase Intermediate 2021 CA` →
`Supabase Root 2021 CA`, self-signed — confirmed the bundled root's SHA-256 matches it,
and ran `pnpm db:migrate` from a simulated image against the live pooler: it reaches
`tenant/user … not found`, i.e. the handshake verified, where before it died on
`self-signed certificate in certificate chain`.

The bundled CA's fingerprint was corroborated two independent ways rather than taken from
the server it authenticates, which would have been circular: fetched from
`supabase-downloads.s3.amazonaws.com` over a publicly-trusted certificate, and compared
against what the pooler presents. `tls.test.ts` pins the fingerprint, so swapping the
file fails a test.

**Storage and Auth have still not met a live project.** They are verified offline —
tokens minted with a real key pair through the real `jose` path, Storage against an
injected `fetch` that answers like the Storage API including the 409 that is its
deduplication signal — which is as far as offline testing goes. Someone with credentials
should upload a document and complete one Supabase sign-in before those two are called
done.
