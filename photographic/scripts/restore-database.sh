#!/usr/bin/env bash
#
# Restores a Photographic database dump into a target, and refuses the ways of doing it that
# look like they worked.
#
# This exists because of one measured trap. `pg_restore --data-only` into a database that
# already has the schema restores **nothing**: tables load alphabetically, so `brief`,
# `chunk`, `document`, `event`, `invite`, `item`, `membership` and `proposal` all fail their
# foreign keys before `person` and `room` arrive. What an operator sees is a wall of
# `COPY failed` lines that reads like noise, and an empty database. Warning about that in a
# runbook is not enough — the runbook is read at 02:00 by someone whose memory is on fire —
# so this script is the documented path and the trap is not reachable through it.
#
# Three guarantees:
#   1. It never passes --data-only into an empty database, and never omits --disable-triggers
#      when loading into one that is not empty.
#   2. It refuses to touch a target that already holds memories unless you say --into-existing,
#      and refuses production outright unless you say so in the environment.
#   3. It fails loudly if the result is an empty database or a migration ledger that does not
#      match the schema — the two outcomes that otherwise pass for success.
#
# Usage:
#   TARGET_DATABASE_URL='postgres://…/photographic_scratch' \
#     scripts/restore-database.sh /tmp/app.dump
#   TARGET_DATABASE_URL=… scripts/restore-database.sh /tmp/app.dump --into-existing
#
# Make the dump with:
#   pg_dump "$DATABASE_URL" -Fc --schema=app -f /tmp/app.dump

set -euo pipefail

DUMP="${1:-}"
INTO_EXISTING=0
for argument in "${@:2}"; do
  case "$argument" in
    --into-existing) INTO_EXISTING=1 ;;
    *) echo "Okänd flagga: $argument" >&2; exit 64 ;;
  esac
done

if [ -z "$DUMP" ] || [ ! -f "$DUMP" ]; then
  echo "Ange en dumpfil: scripts/restore-database.sh <fil> [--into-existing]" >&2
  exit 64
fi

if [ -z "${TARGET_DATABASE_URL:-}" ]; then
  cat >&2 <<'MESSAGE'
TARGET_DATABASE_URL måste vara satt, och den ska peka på ett scratch-mål.

Skälet att den heter något annat än DATABASE_URL är att det inte ska räcka att ha
produktionens uppkoppling i skalet för att skriva över produktionen.
MESSAGE
  exit 64
fi

if [ -n "${DATABASE_URL:-}" ] && [ "$DATABASE_URL" = "$TARGET_DATABASE_URL" ]; then
  if [ "${RESTORE_OVER_PRODUCTION:-}" != "ja-jag-vet-vad-jag-gör" ]; then
    cat >&2 <<'MESSAGE'
TARGET_DATABASE_URL är samma databas som DATABASE_URL.

En återställning skriver över det som finns där nu. Vill du verkligen göra det, sätt
RESTORE_OVER_PRODUCTION='ja-jag-vet-vad-jag-gör'. Vill du bara se om kopian är hel:
återställ till ett tomt mål i stället och jämför med verify-restore.
MESSAGE
    exit 65
  fi
  echo "VARNING: återställer över $(psql "$TARGET_DATABASE_URL" -Atc 'select current_database()')." >&2
fi

for tool in psql pg_restore; do
  command -v "$tool" >/dev/null || { echo "$tool saknas i PATH." >&2; exit 69; }
done

# Supabase's pooler rejects psql 15 and older with a GSSAPI error that reads like a network
# fault. Said here rather than discovered there.
CLIENT_MAJOR="$(pg_restore --version | sed -E 's/[^0-9]*([0-9]+).*/\1/')"
if [ "$CLIENT_MAJOR" -lt 16 ]; then
  echo "VARNING: pg_restore $CLIENT_MAJOR. Supabases pooler kräver 16 eller senare." >&2
fi

MIGRATIONS_DIR="$(cd "$(dirname "$0")/.." && pwd)/packages/db/migrations"
EXPECTED_MIGRATIONS="$(find "$MIGRATIONS_DIR" -name '*.sql' | wc -l | tr -d ' ')"

HAS_SCHEMA="$(psql "$TARGET_DATABASE_URL" -Atc "select to_regclass('app.person') is not null")"

if [ "$HAS_SCHEMA" = "t" ] && [ "$INTO_EXISTING" -eq 0 ]; then
  cat >&2 <<'MESSAGE'
Målet har redan ett app-schema med minnen i.

Att läsa in data i ett befintligt schema är den fälla den här filen finns för: en
--data-only-återställning laddar tabellerna i bokstavsordning, faller på främmande nycklar
innan person och room hunnit fram, och lämnar en TOM databas efter en skärm full av fel.

Två vägar, båda säkra:

  * Ett tomt mål (rekommenderat — det är också det som verifieras i övningen):
        createdb photographic_scratch
        TARGET_DATABASE_URL=postgres://…/photographic_scratch scripts/restore-database.sh <fil>

  * Det här målet ändå, med rätt flaggor och en nollställd migrationsliggare:
        scripts/restore-database.sh <fil> --into-existing
MESSAGE
  exit 66
fi

echo "→ Mål: $(psql "$TARGET_DATABASE_URL" -Atc 'select current_database()') på $(psql "$TARGET_DATABASE_URL" -Atc 'select inet_server_addr()' 2>/dev/null || echo 'okänd värd')"

STATUS=0
if [ "$HAS_SCHEMA" = "t" ]; then
  echo "→ Läser in i befintligt schema: --data-only --disable-triggers, och liggaren nollställs först."
  # Cleared because the dump carries its own eleven rows and the primary key would collide,
  # which would leave the ledger describing the schema that was here before the restore.
  psql "$TARGET_DATABASE_URL" -q -c 'delete from app.schema_migrations'
  pg_restore --data-only --disable-triggers --no-owner --no-privileges \
    -d "$TARGET_DATABASE_URL" "$DUMP" || STATUS=$?
else
  echo "→ Tomt mål: full återställning. Skapar extensions först."
  psql "$TARGET_DATABASE_URL" -q -c 'CREATE EXTENSION IF NOT EXISTS pgcrypto;
                                     CREATE EXTENSION IF NOT EXISTS pg_trgm;
                                     CREATE EXTENSION IF NOT EXISTS citext;
                                     CREATE EXTENSION IF NOT EXISTS vector;
                                     CREATE EXTENSION IF NOT EXISTS unaccent;'
  # --no-owner, not --no-privileges: ownership names a role the target cluster may not have
  # (Supabase's own `postgres`, say), but the GRANTs the dump carries are what make
  # `photographic_app` able to reach anything at all. Measured: with --no-privileges, a
  # restore into an empty database reported "identical: true" from verify-restore — which
  # checks rows, not grants — while photographic_app could SELECT nothing, INSERT nothing,
  # in all 29 tables. The application would have connected to a database that looks whole
  # and answered permission-denied on every query. If the role does not exist yet on this
  # cluster, the GRANT statements for it fail individually and pg_restore reports it in
  # $STATUS below; the schema and data restore either way, and the check just past this one
  # says so explicitly rather than leaving it to be found on the first request.
  pg_restore --no-owner -d "$TARGET_DATABASE_URL" "$DUMP" || STATUS=$?
fi

if [ "$STATUS" -ne 0 ]; then
  echo "→ pg_restore avslutade med $STATUS. Läs felen ovan innan du litar på något nedan." >&2
fi

# ---------------------------------------------------------------------------
# The part that makes a silent failure impossible
# ---------------------------------------------------------------------------

PEOPLE="$(psql "$TARGET_DATABASE_URL" -Atc 'select count(*) from app.person')"
ITEMS="$(psql "$TARGET_DATABASE_URL" -Atc 'select count(*) from app.item')"
EVENTS="$(psql "$TARGET_DATABASE_URL" -Atc 'select count(*) from app.event')"
LEDGER="$(psql "$TARGET_DATABASE_URL" -Atc 'select count(*) from app.schema_migrations')"

echo "→ Efter återställningen: $PEOPLE personer, $ITEMS minnen, $EVENTS händelser, $LEDGER migrationsrader."

if [ "$PEOPLE" = "0" ] || [ "$EVENTS" = "0" ]; then
  cat >&2 <<'MESSAGE'
FEL: databasen är tom efter återställningen.

Det är inte "nästan klart". Kontrollera att dumpfilen är den du tror (pg_restore -l <fil>
listar innehållet) och att den togs med --schema=app eller som hel databas.
MESSAGE
  exit 70
fi

# The ledger trap: a full ledger over a schema that does not have what the ledger claims is
# the one state the migration runner can never repair, because it only ever reads the ledger.
MISSING=""
for probe in "to_regclass('app.storage_object')" "to_regclass('app.export_job')" \
             "(select 1 from information_schema.columns where table_schema='app' and table_name='profile' and column_name='compass')"; do
  PRESENT="$(psql "$TARGET_DATABASE_URL" -Atc "select ($probe) is not null")"
  [ "$PRESENT" = "t" ] || MISSING="$MISSING $probe"
done

if [ -n "$MISSING" ] && [ "$LEDGER" = "$EXPECTED_MIGRATIONS" ]; then
  cat >&2 <<MESSAGE
FEL: liggaren säger $LEDGER migreringar men schemat saknar:$MISSING

Det är det tillstånd som aldrig rättar sig själv — migreringsköraren läser bara liggaren, så
den kommer aldrig att köra det som fattas. Ta bort de felaktiga raderna och kör migreringarna
på riktigt innan något skrivs:

    psql "\$TARGET_DATABASE_URL" -c "delete from app.schema_migrations where id >= '0010'"
    DATABASE_URL="\$TARGET_DATABASE_URL" pnpm db:migrate
MESSAGE
  exit 71
fi

if [ "$LEDGER" != "$EXPECTED_MIGRATIONS" ]; then
  echo "→ Liggaren har $LEDGER rader, avbilden har $EXPECTED_MIGRATIONS filer. Kör pnpm db:migrate mot målet."
fi

# The role trap: the ledger can say 0016/0020 already ran (they did, on the source) while
# this target's photographic_app cannot reach a single row -- either because the role does
# not exist here yet, or because an older dump/restore path stripped the grants with
# --no-privileges. Both look identical to "the restore worked": row counts match, the event
# log is unbroken, verify-restore says identical. Only asking the role itself catches it.
ROLE_EXISTS="$(psql "$TARGET_DATABASE_URL" -Atc "select exists (select 1 from pg_roles where rolname = 'photographic_app')")"
if [ "$ROLE_EXISTS" = "t" ]; then
  ROLE_CAN_READ="$(psql "$TARGET_DATABASE_URL" -Atc "select has_table_privilege('photographic_app', 'app.person', 'SELECT')")"
  if [ "$ROLE_CAN_READ" != "t" ]; then
    cat >&2 <<'MESSAGE'
VARNING: photographic_app finns i klustret men kan inte läsa app.person i den återställda
databasen. Liggaren kan säga att grants-migreringen är körd -- den kördes, på källan, inte
här. En applikation som pekas hit får permission denied på allt, vilket är en total
avbrott som ser ut som en lyckad återställning i varje kontroll utom den här.

    AUDIT_DATABASE_URL="$TARGET_DATABASE_URL" node --import tsx scripts/check-app-role-grants.ts

listar exakt vad som saknas.
MESSAGE
  else
    echo "→ photographic_app kan läsa app.person: grants kom med återställningen."
  fi
else
  echo "→ photographic_app finns inte i det här klustret ännu -- inget att kontrollera. Se scripts/deploy.md."
fi

cat <<MESSAGE

Klart. Två steg kvar innan du kan säga att minnet är tillbaka:

  1. Jämför innehållet mot en avtryck från källan — det här är beviset, inte raderna ovan:
         DATABASE_URL="\$TARGET_DATABASE_URL" pnpm --filter @photographic/ops verify-restore -- \\
           --baseline /tmp/fingerprint-fore.json

  2. Dokumenten ligger inte i databasen. Supabases kopior innehåller inte Storage, så
     originalen kommer från dokumentarkivet:
         DATABASE_URL="\$TARGET_DATABASE_URL" pnpm --filter @photographic/ops restore-documents
MESSAGE
