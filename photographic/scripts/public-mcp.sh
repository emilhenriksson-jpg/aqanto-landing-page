#!/usr/bin/env bash
#
# One public HTTPS URL that Claude can connect to.
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
# The hostname is new on every run, because a quick tunnel is anonymous and disposable.
# That is the right trade for a demo and the wrong one for anything a person keeps
# connected: a connector in Claude points at a hostname, and the next run invalidates it.
# For something that stays up, see scripts/deploy.md.

set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-8787}"
LOG_DIR="${LOG_DIR:-/tmp}"
TUNNEL_LOG="$LOG_DIR/photographic-tunnel.log"
REST_LOG="${REST_LOG:-$LOG_DIR/photographic-rest.log}"

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
# reason it is the lowest-commitment way to be reachable.
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
TUNNEL_CMD=("$CLOUDFLARED" tunnel --url "http://127.0.0.1:$PORT" --no-autoupdate)

echo "== startar tunnel =="
: >"$TUNNEL_LOG"
"${TUNNEL_CMD[@]}" >"$TUNNEL_LOG" 2>&1 &
TUNNEL_PID=$!

cleanup() {
  kill "$TUNNEL_PID" 2>/dev/null || true
  kill "${REST_PID:-}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

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

echo "== startar API på $PUBLIC_URL =="
PUBLIC_URL="$PUBLIC_URL" pnpm dev >"$REST_LOG" 2>&1 &
REST_PID=$!

# Reachable from the outside, not just listening.
#
# Checked through the tunnel rather than on localhost, and the difference is the whole
# point: cloudflared reports a healthy connection and prints a hostname before that
# hostname is published, and a quick tunnel occasionally gets one that never is. Both
# look like success in the log. A banner printed without this check tells you to paste a
# URL into Claude that resolves nowhere.
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
  cat >&2 <<EOF

  $PUBLIC_URL svarar inte utifrån efter 90 s.

  Tunneln kan ha fått ett namn som aldrig publicerades i DNS — det händer, och
  cloudflared säger inget om det. Kör om skriptet; du får ett nytt namn.

  Tunnel: $TUNNEL_LOG
  API:    $REST_LOG

EOF
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
