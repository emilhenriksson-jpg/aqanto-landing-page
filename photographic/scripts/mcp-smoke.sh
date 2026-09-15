#!/usr/bin/env bash
# Morning MCP smoke — prefer documented vitest over fragile live curl.
# See scripts/mcp-smoke.md
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== connect-flow (OAuth + MCP initialize / tools/list) =="
pnpm --filter @photographic/rest exec vitest run src/connect-flow.test.ts

echo
echo "== e2e postgres (ketchup in MCP instructions) =="
(cd e2e && HARNESS=postgres pnpm test)

echo
echo "OK — see scripts/mcp-smoke.md for live localhost:8787 notes."
