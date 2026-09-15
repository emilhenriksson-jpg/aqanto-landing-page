/**
 * Placeholder.
 *
 * The screens for this app are not written yet: `apps/onboarding` covers sign-up, the
 * invite landing, connecting a client and delivery health, and this is where the rooms and
 * the activity feed will go once they are lifted into one app.
 *
 * It exists as a page rather than as a missing module so that the build, the typecheck and
 * `pnpm dev` all stay green, and so that anyone who opens it lands somewhere that tells
 * them where to go instead of on a stack trace.
 */

export function App() {
  return (
    <main className="placeholder">
      <h1>Photographic</h1>
      <p>
        Den här appen är inte byggd än. Kontot skapas och AI-klienter kopplas in i
        onboarding-appen: <code>pnpm --filter @photographic/onboarding dev</code>.
      </p>
      <p>
        API:t och MCP-servern kör redan: <code>pnpm dev</code> startar dem på{' '}
        <code>http://localhost:8787</code>, med MCP på <code>/mcp</code>.
      </p>
    </main>
  );
}
