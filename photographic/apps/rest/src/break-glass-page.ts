/**
 * The page that spends a break-glass token.
 *
 * Its whole job is to move a token from the URL fragment into a POST body. That sounds
 * like an indirection until you ask where else it could go: a query string or a path
 * segment ends up in browser history, in `Referer` on the next navigation, and in any
 * proxy log between the two — which is the same mistake as writing the code to the server
 * log, one layer out. A fragment is the one part of a URL a browser never sends.
 *
 * Served from here rather than added to `apps/onboarding` on purpose. This is the page a
 * locked-out owner loads when something is already wrong, so it must not depend on a Vite
 * build having been made, on a bundle having been copied into the image, or on anything
 * else that can be missing on exactly the day it is needed. No imports, no assets, no
 * framework: if the process answers at all, this page renders.
 */

/** Where the script tells the owner to go, and the only path that serves this. */
export const BREAK_GLASS_PATH = '/nodlage';

/** The endpoint the page posts to. Public, and rate limited with the rest of `/v1/signup`. */
const EXCHANGE_PATH = '/v1/signup/break-glass';

export function breakGlassPage(): string {
  return `<!doctype html>
<html lang="sv">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Nödinloggning · Photografic</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; display: grid; place-items: center;
         min-height: 100vh; background: #faf9f7; color: #1c1a17; padding: 24px; }
  main { max-width: 32rem; }
  h1 { font-size: 1.35rem; margin: 0 0 .5rem; }
  p { margin: 0 0 .75rem; }
  code { background: #efece7; padding: .1rem .3rem; border-radius: .2rem; }
</style>
<main>
  <h1>Nödinloggning</h1>
  <p id="status">Loggar in dig …</p>
  <p id="help" hidden>Kör skriptet på maskinen igen och öppna den nya länken:
    <code>fly ssh console -C "node --import tsx /app/scripts/break-glass-signin.ts DITT-NUMMER"</code></p>
</main>
<script>
  (function () {
    var status = document.getElementById('status');
    var help = document.getElementById('help');
    var token = location.hash.slice(1);

    function fail(message) {
      status.textContent = message;
      help.hidden = false;
    }

    // Out of the address bar before the request is made, so the token is not left sitting
    // in history or in the next Referer even if the exchange fails.
    if (token) history.replaceState(null, '', location.pathname);
    if (!token) return fail('Länken saknar nödkod. Den måste öppnas exakt som skriptet skrev den.');

    fetch(${JSON.stringify(EXCHANGE_PATH)}, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ token: token }),
    })
      .then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (data) {
          if (response.ok) {
            status.textContent = 'Klart. Öppnar ditt minne …';
            location.replace('/');
            return;
          }
          fail((data.error && data.error.message) || 'Nödkoden gäller inte.');
        });
      })
      .catch(function () { fail('Kunde inte nå servern. Försök igen.'); });
  })();
</script>
<noscript>
  <p>Den här sidan behöver JavaScript. Utan det: kopiera nödkoden efter <code>#</code> i länken och kör
     <code>curl -c cookies.txt -X POST https://mcp.photographic.space/v1/signup/break-glass -H 'content-type: application/json' -d '{"token":"NÖDKOD"}'</code></p>
</noscript>
</html>
`;
}
