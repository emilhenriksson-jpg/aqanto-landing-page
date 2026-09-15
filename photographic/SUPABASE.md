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

Two things differ from a Postgres on localhost, and both fail in ways that look like
something else. `packages/supabase/src/database.ts` handles both and logs which it
chose, because these are load-dependent failures that no test will catch.

**TLS.** Required, and verified against the system trust store by default. If your
platform cannot chain Supabase's certificate, supply the project CA rather than turning
verification off:

```bash
export SUPABASE_CA_CERT="$(cat prod-ca-2021.crt)"
```

`SUPABASE_ALLOW_UNVERIFIED_TLS=1` exists and is a worse answer: encrypted but not
authenticated, which stops passive reading of the wire and not an active attacker in
front of the database.

**The transaction pooler.** Port `6543` is pgBouncer in transaction mode and does not
support prepared statements, which `pg` uses for every parameterised query. The symptom
is that everything works under light load and then fails with `prepared statement
"..." already exists` once two requests share a backend. Detected automatically.

**Run migrations against port 5432**, not the pooler — some DDL does not survive
transaction pooling.

```bash
# Migrations and seeds: direct connection.
DATABASE_URL='postgres://postgres:PW@db.PROJECT.supabase.co:5432/postgres' pnpm db:migrate

# The application: pooler is fine and preferable.
DATABASE_URL='postgres://postgres.PROJECT:PW@aws-0-REGION.pooler.supabase.com:6543/postgres' pnpm dev
```

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
{"msg":"oauth_persistence","kind":"postgres"}
{"msg":"blob_storage","kind":"supabase"}
{"msg":"supabase","storage":true,"auth":true}
```

`supabase_incomplete` warnings name exactly what is missing, in Swedish. A project
configured for Postgres but not Storage is a normal state and logs a warning rather than
refusing to boot — but an operator should know before someone uploads a file.

## Current status

Everything above is built and tested. `packages/supabase` has 35 tests: tokens are
minted with a real key pair and verified through the real `jose` path, and Storage runs
against an injected `fetch` that answers like the Storage API does, including the 409
that is its deduplication signal.

**No Supabase project was available when this was written**, so the database, Auth and
Storage paths are verified against local Postgres 16 with pgvector, real signed tokens,
and a faked Storage API rather than against a live project. The adapters are correct as
far as offline testing can establish and have not met a real project. Someone with
credentials should run `pnpm db:migrate` against one and upload a document before this
is called done.
