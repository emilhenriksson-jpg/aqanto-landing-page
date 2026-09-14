# Getting a public URL so Claude can connect

Claude reaches an MCP server from Anthropic's cloud, not from your laptop, so the
server has to be on the public internet. Two ways, depending on whether you want this
to survive you closing the lid.

## Quick, for trying it out

Run the server locally and put a tunnel in front of it:

```bash
pnpm db:migrate
pnpm dev                       # serves on :8080
npx untun@latest tunnel http://localhost:8080
```

Take the https URL it prints and add `/mcp` to it.

## Real, ten minutes

```bash
fly launch --no-deploy            # accept the existing fly.toml
fly postgres create --name photographic-db --region arn
fly postgres attach photographic-db
fly secrets set OPENAI_API_KEY=sk-...
fly deploy
```

Your MCP endpoint is then `https://<app>.fly.dev/mcp`.

## Pointing Claude at it

In Claude: **Customize → Connectors → + → Add custom connector**, paste the `/mcp`
URL, and complete the OAuth flow. Works on Free, Pro and Max. Add it from web or
desktop first — installing connectors from mobile is still in beta — after which it
works in the mobile app too.

## Pointing ChatGPT at it

Web only, and it is a developer-mode feature rather than something a normal person
will do: **Settings → Security and login → Developer mode**, then create a
developer-mode app pointing at the same `/mcp` URL.

ChatGPT on mobile cannot use MCP at all, and its voice mode reportedly cannot call
connectors even on the web. For ChatGPT the practical path today is to copy the text
from `/v1/context/rendered` into Custom Instructions, which is exactly why that
endpoint returns plain text.
