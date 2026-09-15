#!/usr/bin/env bash
#
# One public HTTPS URL that Claude can connect to, for local development.
#
# Both modes below are a laptop/VM tunnel, which is a development convenience, not the
# production answer: the tunnel dies with whatever machine started it — a laptop lid
# closing, a Cloud Agent VM being torn down. Production is a real deploy (Fly, serving
# `mcp.photographic.space`) — see scripts/deploy.md.
#
# Puts a tunnel in front of the local process and starts that process knowing the
# hostname it will be reached on. The order matters: PUBLIC_URL is the OAuth issuer, the
# resource identifier and the base of every URL the metadata documents hand out, so it
# has to be the tunnel hostname before the first request arrives, not after. Restarting
# the API to correct it means every client that already registered has the wrong issuer.
#
#   ./scripts/public-mcp.sh
#
# Then paste the printed /mcp URL into Claude → Customize → Connectors → Add custom
# connector. Ctrl-C stops both.
#
# Two tunnel modes:
#
#   Quick tunnel (default). No account, no configuration. The hostname is new on every
#   run, because it is anonymous and disposable. Right for a demo, wrong for a connector
#   you want to keep working: it dies with this process and the next run gets a
#   different name, so a client that registered against it has to register again.
#
#   Named tunnel (opt-in). Set TUNNEL_HOSTNAME to a hostname on a domain in your
#   Cloudflare account and this script brings the tunnel up on that exact hostname
#   instead — the same one every run, so a connector saved in Claude survives a restart
#   of this process. Needs credentials, one of:
#     - TUNNEL_TOKEN            a remotely-managed tunnel token (simplest — see deploy.md)
#     - TUNNEL_ID + TUNNEL_CREDENTIALS_FILE   a locally-managed tunnel's id/name and the
#                                             credentials file `cloudflared tunnel create`
#                                             wrote
#   If TUNNEL_HOSTNAME is set without either, this refuses to start rather than falling
#   back to a random quick-tunnel hostname — a silent fallback here is worse than a
#   startup error, because it looks like success right up until a client registers
#   against the wrong origin. See scripts/deploy.md for the one-time Cloudflare setup.
#
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-8787}"
LOG_DIR="${LOG_DIR:-/tmp}"
TUNNEL_LOG="$LOG_DIR/photographic-tunnel.log"
REST_LOG="${REST_LOG:-$LOG_DIR/photographic-rest.log}"
TUNNEL_HOSTNAME="${TUNNEL_HOSTNAME:-}"
TUNNEL_TOKEN="${TUNNEL_TOKEN:-}"
TUNNEL_ID="${TUNNEL_ID:-}"
TUNNEL_CREDENTIALS_FILE="${TUNNEL_CREDENTIALS_FILE:-}"
TUNNEL_CONFIG=""

# The browser app is served from the API origin, so the login page an authorization
# request redirects to is on the tunnel too. Without a build there is nothing to serve,
# the flow dead-ends after the redirect, and the only symptom is a blank page — so build
# it here rather than leaving it to be remembered.
if [[ ! -f apps/onboarding/dist/index.html ]]; then
  echo "== bygger webbappen (inloggningssidan) =="
  pnpm --filter @photographic/onboarding run build
fi

# cloudflared, not `npx untun`.
#
# untun is the shorter command and is what this repo used to recommend, but 0.2.2 ships
# `dist/cli.mjs` with no shebang, so npx's shim hands it to `sh` and every line is a
# syntax error. It drives cloudflared underneath anyway; this just skips the wrapper.
#
# A quick tunnel needs no Cloudflare account and no configuration, which is the whole
# reason it is the lowest-commitment way to be reachable. A named tunnel needs the same
# binary, just a different subcommand.
find_cloudflared() {
  if command -v cloudflared >/dev/null 2>&1; then
    command -v cloudflared
    return 0
  fi

  local cache="${XDG_CACHE_HOME:-$HOME/.cache}/photographic"
  if [[ -x "$cache/cloudflared" ]]; then
    echo "$cache/cloudflared"
    return 0
  fi

  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"
  if [[ "$os" != "Linux" ]]; then
    echo "Installera cloudflared först: brew install cloudflared" >&2
    return 1
  fi
  case "$arch" in
    x86_64) arch=amd64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) echo "Okänd arkitektur $arch. Installera cloudflared för hand." >&2; return 1 ;;
  esac

  mkdir -p "$cache"
  echo "== hämtar cloudflared =="  >&2
  curl -fsSL -o "$cache/cloudflared" \
    "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$arch"
  chmod +x "$cache/cloudflared"
  echo "$cache/cloudflared"
}

CLOUDFLARED="$(find_cloudflared)"

# Named tunnel, opt-in by config. TUNNEL_HOSTNAME is the only thing that decides the
# mode — its presence is the opt-in, and it is used exactly as given, never guessed or
# derived from anything else, because a wrong guess here is a wrong OAuth issuer.
NAMED_TUNNEL=0
if [[ -n "$TUNNEL_HOSTNAME" ]]; then
  NAMED_TUNNEL=1
  if [[ -n "$TUNNEL_TOKEN" ]]; then
    # Remotely-managed tunnel: the public hostname → local port mapping lives in the
    # Cloudflare dashboard against this token, so the only local input is the token
    # itself. See scripts/deploy.md for where this comes from.
    TUNNEL_CMD=("$CLOUDFLARED" tunnel --no-autoupdate run --token "$TUNNEL_TOKEN")
  elif [[ -n "$TUNNEL_ID" && -n "$TUNNEL_CREDENTIALS_FILE" ]]; then
    if [[ ! -f "$TUNNEL_CREDENTIALS_FILE" ]]; then
      echo "TUNNEL_CREDENTIALS_FILE pekar på $TUNNEL_CREDENTIALS_FILE, som inte finns." >&2
      exit 1
    fi
    # Locally-managed tunnel: cloudflared needs an ingress mapping from the hostname to
    # this process's port. Generated rather than a checked-in config.yml, because the
    # port and hostname are both run-time inputs, not fixed for the repo.
    TUNNEL_CONFIG="$LOG_DIR/photographic-tunnel-config.yml"
    cat >"$TUNNEL_CONFIG" <<EOF
tunnel: $TUNNEL_ID
credentials-file: $TUNNEL_CREDENTIALS_FILE
ingress:
  - hostname: $TUNNEL_HOSTNAME
    service: http://127.0.0.1:$PORT
  - service: http_status:404
EOF
    TUNNEL_CMD=("$CLOUDFLARED" tunnel --no-autoupdate --config "$TUNNEL_CONFIG" run "$TUNNEL_ID")
  else
    cat >&2 <<EOF

  TUNNEL_HOSTNAME=$TUNNEL_HOSTNAME är satt, men inga tunnel-credentials.

  Sätt en av dessa, annars startar inte skriptet — en tyst reserv till en slumpad
  quick-tunnel-URL hade sett ut som en lyckad start ända fram tills en klient
  registrerar sig mot fel origin:

    TUNNEL_TOKEN                                    (rekommenderas, se scripts/deploy.md)
    TUNNEL_ID + TUNNEL_CREDENTIALS_FILE              (lokalt hanterad tunnel)

EOF
    exit 1
  fi
else
  # Quick tunnel: anonymous, disposable, no account needed.
  TUNNEL_CMD=("$CLOUDFLARED" tunnel --url "http://127.0.0.1:$PORT" --no-autoupdate)
fi

if [[ "$NAMED_TUNNEL" -eq 1 ]]; then
  echo "== startar tunnel (namngiven: $TUNNEL_HOSTNAME) =="
else
  echo "== startar tunnel (quick tunnel) =="
fi
: >"$TUNNEL_LOG"
"${TUNNEL_CMD[@]}" >"$TUNNEL_LOG" 2>&1 &
TUNNEL_PID=$!

cleanup() {
  kill "$TUNNEL_PID" 2>/dev/null || true
  kill "${REST_PID:-}" 2>/dev/null || true
  [[ -n "$TUNNEL_CONFIG" ]] && rm -f "$TUNNEL_CONFIG"
}
trap cleanup EXIT INT TERM

if [[ "$NAMED_TUNNEL" -eq 1 ]]; then
  # The hostname is already known — it was given, not discovered — so there is nothing
  # to scrape from the log. Just confirm cloudflared did not die on startup (a bad token
  # or an unreadable credentials file fails within a second or two).
  sleep 2
  if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
    echo "Tunneln dog direkt. Kontrollera TUNNEL_TOKEN / TUNNEL_ID / TUNNEL_CREDENTIALS_FILE. Logg: $TUNNEL_LOG" >&2
    exit 1
  fi
  PUBLIC_URL="https://$TUNNEL_HOSTNAME"
else
  PUBLIC_URL=""
  for _ in $(seq 1 60); do
    PUBLIC_URL="$(grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" | head -1 || true)"
    [[ -n "$PUBLIC_URL" ]] && break
    if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
      echo "Tunneln dog. Logg: $TUNNEL_LOG" >&2
      exit 1
    fi
    sleep 1
  done

  if [[ -z "$PUBLIC_URL" ]]; then
    echo "Ingen tunnel-URL på 60 s. Logg: $TUNNEL_LOG" >&2
    exit 1
  fi
fi

echo "== startar API på $PUBLIC_URL =="
PUBLIC_URL="$PUBLIC_URL" pnpm dev >"$REST_LOG" 2>&1 &
REST_PID=$!

# Reachable from the outside, not just listening.
#
# Checked through the tunnel rather than on localhost, and the difference is the whole
# point: cloudflared reports a healthy connection and prints a hostname before that
# hostname is published, and a quick tunnel occasionally gets one that never is. Both
# look like success in the log. A banner printed without this check tells you to paste a
# URL into Claude that resolves nowhere. The same check catches a named tunnel whose DNS
# record was never created, or whose Public Hostname route points at the wrong port.
REACHABLE=""
for _ in $(seq 1 90); do
  if curl -fsS -m 5 "$PUBLIC_URL/health" >/dev/null 2>&1; then
    REACHABLE=1
    break
  fi
  if ! kill -0 "$REST_PID" 2>/dev/null; then
    echo "API:t dog. Logg: $REST_LOG" >&2
    exit 1
  fi
  if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
    echo "Tunneln dog. Logg: $TUNNEL_LOG" >&2
    exit 1
  fi
  sleep 1
done

if [[ -z "$REACHABLE" ]]; then
  if [[ "$NAMED_TUNNEL" -eq 1 ]]; then
    cat >&2 <<EOF

  $PUBLIC_URL svarar inte utifrån efter 90 s.

  Vanliga orsaker för en namngiven tunnel, i ungefärlig sannolikhetsordning:
    - Zonen för hostnamnet ligger inte på Cloudflares nameservers än (kan ta upp till
      ett dygn efter bytet hos registraren). Kolla att zonen visas som "Active" i
      Cloudflare-dashboarden.
    - Tunnelns Public Hostname-route pekar på fel lokal port eller fel schema
      (http vs https).
    - TUNNEL_TOKEN eller TUNNEL_ID/TUNNEL_CREDENTIALS_FILE hör till en annan tunnel än
      den som äger $TUNNEL_HOSTNAME.
    - DNS-posten för $TUNNEL_HOSTNAME finns inte än (skapas normalt automatiskt när du
      lägger till Public Hostname-routen i Cloudflare).

  Se scripts/deploy.md för hela uppsättningen, steg för steg.

  Tunnel: $TUNNEL_LOG
  API:    $REST_LOG

EOF
  else
    cat >&2 <<EOF

  $PUBLIC_URL svarar inte utifrån efter 90 s.

  Tunneln kan ha fått ett namn som aldrig publicerades i DNS — det händer, och
  cloudflared säger inget om det. Kör om skriptet; du får ett nytt namn.

  Tunnel: $TUNNEL_LOG
  API:    $REST_LOG

EOF
  fi
  exit 1
fi

cat <<EOF

  MCP:     $PUBLIC_URL/mcp
  Logga in: $PUBLIC_URL/login
  Health:  $PUBLIC_URL/health

  Claude → Customize → Connectors → Add custom connector → klistra in MCP-URL:en.
  Signup-koden skrivs i loggen: grep signup_code $REST_LOG

  Rök mot den publika URL:en, i ett annat skal:
    LIVE_MCP=1 LIVE_MCP_URL=$PUBLIC_URL LIVE_MCP_PUBLIC_URL=$PUBLIC_URL \\
      LIVE_MCP_LOG=$REST_LOG pnpm --filter @photographic/e2e test:live

  Ctrl-C stoppar båda.

EOF

wait "$REST_PID"
