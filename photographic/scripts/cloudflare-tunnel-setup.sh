#!/usr/bin/env bash
#
# One-time Cloudflare setup for the named tunnel — a development convenience for a
# stable local hostname, not the production route (production is a real deploy behind
# a plain DNS record; see scripts/deploy.md and scripts/cloudflare-dns-record.sh).
# Driven by the API instead of the dashboard, so it is repeatable and Emil does not have
# to click through Zero Trust by hand. Idempotent: safe to re-run after a partial
# failure or to pick up a hostname change.
#
# Needs, as environment secrets (never printed, never written to a file):
#   CLOUDFLARE_API_TOKEN    scoped to Account: Cloudflare Tunnel: Edit,
#                           Zone: DNS: Edit on the zone that owns TUNNEL_HOSTNAME,
#                           Zone: Zone: Read
#   CLOUDFLARE_ACCOUNT_ID   the Cloudflare account that owns the tunnel
#
# Everything else has a default that matches this project's target hostname, but none
# of it is hardcoded into the logic below — override any of it for a different domain:
#   TUNNEL_HOSTNAME   default mcp.photographic.space — the stable hostname to route
#   TUNNEL_NAME       default photographic-mcp — the tunnel's name in Cloudflare
#   PORT              default 8787 — the local port the tunnel should point at
#   CLOUDFLARE_ZONE_NAME   skip the zone-lookup walk and use this zone name directly
#
# On success, writes TUNNEL_HOSTNAME and TUNNEL_TOKEN to $TUNNEL_ENV_FILE (default
# /tmp/photographic-tunnel.env) as `export` lines. `source` that file, then run
# `./scripts/public-mcp.sh` — it reads exactly those two variables. The token is a
# secret with the same reach as the account permissions above; the file is written
# under /tmp rather than the repo on purpose, and is yours to delete when done.
#
# What this does NOT do: touch nameservers. The zone lookup below fails with a clear
# message if the zone is not already active in this Cloudflare account — moving a
# domain's nameservers is a one-time step Emil takes at his registrar, described in
# scripts/deploy.md, and no API token scoped to an account can do it for him.
#
set -euo pipefail
cd "$(dirname "$0")/.."

TUNNEL_HOSTNAME="${TUNNEL_HOSTNAME:-mcp.photographic.space}"
TUNNEL_NAME="${TUNNEL_NAME:-photographic-mcp}"
PORT="${PORT:-8787}"
TUNNEL_ENV_FILE="${TUNNEL_ENV_FILE:-/tmp/photographic-tunnel.env}"
# Override point for tests: points a mock server at the same request shapes without
# touching the real Cloudflare API. Never set this for a real run.
CF_API="${CF_API_BASE:-https://api.cloudflare.com/client/v4}"

if ! command -v jq >/dev/null 2>&1; then
  echo "jq krävs (apt-get install -y jq / brew install jq)." >&2
  exit 1
fi

missing=()
[[ -z "${CLOUDFLARE_API_TOKEN:-}" ]] && missing+=("CLOUDFLARE_API_TOKEN")
[[ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]] && missing+=("CLOUDFLARE_ACCOUNT_ID")
if [[ ${#missing[@]} -gt 0 ]]; then
  cat >&2 <<EOF

  Saknar: ${missing[*]}

  Detta skript pratar med Cloudflares API för att skapa/uppdatera tunneln, dess
  ingress och DNS-posten. Utan dessa körs ingenting — ingen reserv, inget gissat.

  CLOUDFLARE_API_TOKEN ska ha behörigheterna:
    Account: Cloudflare Tunnel: Edit
    Zone: DNS: Edit           (på zonen som äger $TUNNEL_HOSTNAME)
    Zone: Zone: Read

  Se scripts/deploy.md för var de skapas och sätts.

EOF
  exit 1
fi

AUTH_HEADER="Authorization: Bearer $CLOUDFLARE_API_TOKEN"

# Every call goes through here so a Cloudflare-side failure — bad scope, rate limit,
# a typo'd account id — surfaces with the actual response body instead of a bare curl
# exit code. Deliberately not `curl -f`: Cloudflare's error responses are a JSON body
# with `success:false` and a real message, on a non-2xx status, and `-f` would discard
# exactly that body, leaving only "something failed".
cf() {
  local method="$1" path="$2" body="${3:-}"
  local out http response
  if [[ -n "$body" ]]; then
    out="$(curl -sS -w '\n%{http_code}' -X "$method" "$CF_API$path" \
      -H "$AUTH_HEADER" -H "Content-Type: application/json" \
      --data "$body")" || {
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

echo "== hittar zonen som äger $TUNNEL_HOSTNAME =="
ZONE_NAME=""
ZONE_ID=""
if [[ -n "${CLOUDFLARE_ZONE_NAME:-}" ]]; then
  ZONE_NAME="$CLOUDFLARE_ZONE_NAME"
  ZONE_ID="$(cf GET "/zones?name=$ZONE_NAME" | jq -r '.result[0].id // empty')"
  if [[ -z "$ZONE_ID" ]]; then
    echo "CLOUDFLARE_ZONE_NAME=$ZONE_NAME finns inte i det här Cloudflare-kontot." >&2
    exit 1
  fi
else
  # Walk from the full hostname down to its registrable domain — "mcp.photographic.space"
  # tries "mcp.photographic.space", then "photographic.space", then "space" — and stops
  # at the first one that is an actual zone in this account. This resolves which zone
  # owns the hostname without guessing the hostname itself.
  candidate="$TUNNEL_HOSTNAME"
  while [[ -n "$candidate" ]]; do
    ZONE_ID="$(cf GET "/zones?name=$candidate" | jq -r '.result[0].id // empty')"
    if [[ -n "$ZONE_ID" ]]; then
      ZONE_NAME="$candidate"
      break
    fi
    [[ "$candidate" != *.* ]] && break
    candidate="${candidate#*.}"
  done
  if [[ -z "$ZONE_ID" ]]; then
    cat >&2 <<EOF

  Ingen zon i det här Cloudflare-kontot äger $TUNNEL_HOSTNAME.

  Vanligast: domänen ligger inte på Cloudflares nameservers än. Lägg till den
  ("Add a site") i Cloudflare-dashboarden och byt nameservers hos registraren —
  se scripts/deploy.md. Detta skript kan inte göra nameserver-bytet; det är ett
  steg Emil tar hos registraren, en gång.

EOF
    exit 1
  fi
fi
echo "   zon: $ZONE_NAME ($ZONE_ID)"

echo "== hittar eller skapar tunneln \"$TUNNEL_NAME\" =="
TUNNEL_ID="$(cf GET "/accounts/$CLOUDFLARE_ACCOUNT_ID/cfd_tunnel?name=$TUNNEL_NAME&is_deleted=false" \
  | jq -r '.result[0].id // empty')"
if [[ -z "$TUNNEL_ID" ]]; then
  TUNNEL_ID="$(cf POST "/accounts/$CLOUDFLARE_ACCOUNT_ID/cfd_tunnel" \
    "$(jq -n --arg name "$TUNNEL_NAME" '{name: $name, config_src: "cloudflare"}')" \
    | jq -r '.result.id')"
  echo "   skapad: $TUNNEL_ID"
else
  echo "   återanvänder: $TUNNEL_ID"
fi

echo "== pekar tunnelns publika hostnamn på 127.0.0.1:$PORT =="
cf PUT "/accounts/$CLOUDFLARE_ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID/configurations" \
  "$(jq -n --arg hostname "$TUNNEL_HOSTNAME" --arg port "$PORT" '
    {config: {ingress: [
      {hostname: $hostname, service: ("http://127.0.0.1:" + $port)},
      {service: "http_status:404"}
    ]}}
  ')" >/dev/null

echo "== säkrar DNS-posten för $TUNNEL_HOSTNAME =="
CNAME_TARGET="$TUNNEL_ID.cfargotunnel.com"
existing="$(cf GET "/zones/$ZONE_ID/dns_records?type=CNAME&name=$TUNNEL_HOSTNAME")"
existing_id="$(echo "$existing" | jq -r '.result[0].id // empty')"
existing_content="$(echo "$existing" | jq -r '.result[0].content // empty')"
if [[ -z "$existing_id" ]]; then
  cf POST "/zones/$ZONE_ID/dns_records" \
    "$(jq -n --arg name "$TUNNEL_HOSTNAME" --arg content "$CNAME_TARGET" \
      '{type: "CNAME", proxied: true, name: $name, content: $content}')" >/dev/null
  echo "   skapad: CNAME $TUNNEL_HOSTNAME -> $CNAME_TARGET"
elif [[ "$existing_content" == "$CNAME_TARGET" ]]; then
  echo "   redan rätt: CNAME $TUNNEL_HOSTNAME -> $CNAME_TARGET"
else
  cat >&2 <<EOF

  Det finns redan en CNAME för $TUNNEL_HOSTNAME som pekar på $existing_content,
  inte på $CNAME_TARGET (den här tunnelns mål). Skriver inte över den automatiskt —
  ta bort eller ändra den posten i Cloudflare DNS för hand, sen kör om.

EOF
  exit 1
fi

echo "== hämtar tunnel-token =="
TUNNEL_TOKEN="$(cf GET "/accounts/$CLOUDFLARE_ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID/token" | jq -r '.result')"

{
  echo "export TUNNEL_HOSTNAME=$TUNNEL_HOSTNAME"
  echo "export TUNNEL_TOKEN=$TUNNEL_TOKEN"
} >"$TUNNEL_ENV_FILE"
chmod 600 "$TUNNEL_ENV_FILE"

cat <<EOF

  Klart. Tunnel: $TUNNEL_NAME ($TUNNEL_ID)
  Hostnamn:      $TUNNEL_HOSTNAME
  Token skriven till: $TUNNEL_ENV_FILE (rättigheter 600, innehåller en hemlighet)

  Nästa steg:
    source $TUNNEL_ENV_FILE
    ./scripts/public-mcp.sh

EOF
