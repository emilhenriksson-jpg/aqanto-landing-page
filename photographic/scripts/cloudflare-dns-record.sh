#!/usr/bin/env bash
#
# Create or update one DNS record in Cloudflare, idempotently — for pointing
# mcp.photographic.space (or any other hostname) at a real deploy once one exists.
# Generic on purpose: `fly certs add <hostname>` / `fly certs setup <hostname>` print
# the exact record(s) a given Fly app needs (A, AAAA, CNAME, or a `_fly-ownership` TXT,
# depending on how the domain and cert are set up), and this script adds exactly the one
# you tell it to — it does not guess or hardcode a deploy target.
#
#   CLOUDFLARE_API_TOKEN=... ./scripts/cloudflare-dns-record.sh <type> <name> <content> [proxied]
#
# Example, after `fly certs setup mcp.photographic.space` says to add a CNAME to
# photographic.fly.dev:
#
#   ./scripts/cloudflare-dns-record.sh CNAME mcp.photographic.space photographic.fly.dev false
#
# `proxied` (last arg, default false) is Cloudflare's orange-cloud toggle. Off ("DNS
# only") is the safer default for pointing at a platform that already terminates its own
# TLS and does its own certificate validation against the record — Fly's cert issuance
# expects to see the real record, and Cloudflare's proxy sitting in front of it is an
# extra moving part (SSL mode, an ownership TXT record, potential validation loops) this
# script does not set up. Turn it on later, deliberately, if you want Cloudflare's CDN/WAF
# in front too.
#
# Needs, as an environment secret:
#   CLOUDFLARE_API_TOKEN   scoped to Zone: DNS: Edit + Zone: Zone: Read on the zone that
#                          owns the hostname you are pointing
#
# Refuses to overwrite an existing record that already points somewhere else — a script
# that silently repoints someone's DNS is worse than one that stops and asks. Set FORCE=1
# to update it anyway, once you have confirmed that is what you want.
#
set -euo pipefail

TYPE="${1:-}"
NAME="${2:-}"
CONTENT="${3:-}"
PROXIED="${4:-false}"
CF_API="${CF_API_BASE:-https://api.cloudflare.com/client/v4}"

if [[ -z "$TYPE" || -z "$NAME" || -z "$CONTENT" ]]; then
  echo "Användning: CLOUDFLARE_API_TOKEN=... $0 <TYPE> <NAME> <CONTENT> [proxied=false]" >&2
  echo "Exempel:    $0 CNAME mcp.photographic.space photographic.fly.dev false" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq krävs (apt-get install -y jq / brew install jq)." >&2
  exit 1
fi

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  cat >&2 <<EOF

  Saknar CLOUDFLARE_API_TOKEN.

  Ska ha behörigheterna Zone: DNS: Edit (på zonen som äger $NAME) och Zone: Zone: Read.
  Se scripts/deploy.md.

EOF
  exit 1
fi

AUTH_HEADER="Authorization: Bearer $CLOUDFLARE_API_TOKEN"

# See scripts/cloudflare-tunnel-setup.sh for the same helper, duplicated rather than
# shared — two small standalone scripts are easier to read and review in full than one
# with a sourced library, for something this short.
cf() {
  local method="$1" path="$2" body="${3:-}"
  local out http response
  if [[ -n "$body" ]]; then
    out="$(curl -sS -w '\n%{http_code}' -X "$method" "$CF_API$path" \
      -H "$AUTH_HEADER" -H "Content-Type: application/json" --data "$body")" || {
      echo "Kunde inte nå Cloudflares API för $method $path (nätverksfel)." >&2
      exit 1
    }
  else
    out="$(curl -sS -w '\n%{http_code}' -X "$method" "$CF_API$path" -H "$AUTH_HEADER")" || {
      echo "Kunde inte nå Cloudflares API för $method $path (nätverksfel)." >&2
      exit 1
    }
  fi
  http="${out##*$'\n'}"
  response="${out%$'\n'*}"
  if [[ "$(echo "$response" | jq -r '.success // "false"' 2>/dev/null)" != "true" ]]; then
    echo "Cloudflare svarade $http på $method $path:" >&2
    echo "$response" | jq -c '.errors // .' >&2 2>/dev/null || echo "$response" >&2
    exit 1
  fi
  echo "$response"
}

echo "== hittar zonen som äger $NAME =="
ZONE_ID=""
ZONE_NAME=""
if [[ -n "${CLOUDFLARE_ZONE_NAME:-}" ]]; then
  ZONE_NAME="$CLOUDFLARE_ZONE_NAME"
  ZONE_ID="$(cf GET "/zones?name=$ZONE_NAME" | jq -r '.result[0].id // empty')"
else
  candidate="$NAME"
  while [[ -n "$candidate" ]]; do
    ZONE_ID="$(cf GET "/zones?name=$candidate" | jq -r '.result[0].id // empty')"
    if [[ -n "$ZONE_ID" ]]; then
      ZONE_NAME="$candidate"
      break
    fi
    [[ "$candidate" != *.* ]] && break
    candidate="${candidate#*.}"
  done
fi
if [[ -z "$ZONE_ID" ]]; then
  echo "Ingen zon i det här Cloudflare-kontot äger $NAME." >&2
  exit 1
fi
echo "   zon: $ZONE_NAME ($ZONE_ID)"

echo "== säkrar $TYPE-posten för $NAME =="
existing="$(cf GET "/zones/$ZONE_ID/dns_records?type=$TYPE&name=$NAME")"
existing_id="$(echo "$existing" | jq -r '.result[0].id // empty')"
existing_content="$(echo "$existing" | jq -r '.result[0].content // empty')"

if [[ -z "$existing_id" ]]; then
  cf POST "/zones/$ZONE_ID/dns_records" \
    "$(jq -n --arg type "$TYPE" --arg name "$NAME" --arg content "$CONTENT" --argjson proxied "$PROXIED" \
      '{type: $type, name: $name, content: $content, proxied: $proxied}')" >/dev/null
  echo "   skapad: $TYPE $NAME -> $CONTENT"
elif [[ "$existing_content" == "$CONTENT" ]]; then
  echo "   redan rätt: $TYPE $NAME -> $CONTENT"
elif [[ "${FORCE:-}" == "1" ]]; then
  cf PATCH "/zones/$ZONE_ID/dns_records/$existing_id" \
    "$(jq -n --arg type "$TYPE" --arg name "$NAME" --arg content "$CONTENT" --argjson proxied "$PROXIED" \
      '{type: $type, name: $name, content: $content, proxied: $proxied}')" >/dev/null
  echo "   uppdaterad: $TYPE $NAME $existing_content -> $CONTENT (FORCE=1)"
else
  cat >&2 <<EOF

  Det finns redan en $TYPE-post för $NAME som pekar på $existing_content,
  inte på $CONTENT. Skriver inte över den automatiskt.

  Om det nya målet verkligen ska ersätta det gamla: kör om med FORCE=1.
  Annars: ta bort/ändra posten i Cloudflare DNS för hand.

EOF
  exit 1
fi
