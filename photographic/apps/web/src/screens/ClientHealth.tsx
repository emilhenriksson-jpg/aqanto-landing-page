import { CalmState, LoadingState } from '../components/CalmState.js';
import { Wordmark } from '../components/Wordmark.js';
import {
  DEMO_CLIENTS,
  clientHealthTone,
  type ClientHealthTone,
  type DemoClient,
} from '../data/demo.js';
import { loadClientsFromApi } from '../data/load.js';
import { useRoomData } from '../hooks/useRoomData.js';

/**
 * Honesty feature: which connected AIs actually received the personal profile.
 * A quiet vertical list — standing in the product, not an ops status grid.
 * Swedish; violet only on the wordmark.
 */
export function ClientHealth() {
  const state = useRoomData(
    'clients',
    () => DEMO_CLIENTS,
    () => loadClientsFromApi(),
  );

  if (state.status === 'loading') return <LoadingState label="Hämtar klienter…" />;
  if (state.status === 'error') {
    return <CalmState title="Klienter" message={state.message} />;
  }

  return (
    <article className="page page--health">
      <header className="page-head page-head--health">
        <Wordmark large />
        <h1 className="page-head__title">Klienter</h1>
        <p className="page-head__lede">
          Vi kan inte tvinga varje modell att läsa ditt rum. Här syns vilka som fick din
          profil, och hur.
        </p>
      </header>

      {state.data.length === 0 ? (
        <p className="section-block__empty">Inga kopplade AI:er ännu.</p>
      ) : (
        <ul className="health">
          {state.data.map((client) => (
            <ClientRow key={client.id} client={client} />
          ))}
        </ul>
      )}
    </article>
  );
}

function ClientRow({ client }: { client: DemoClient }) {
  const tone = clientHealthTone(client);
  const detail = statusCopy(client, tone);

  return (
    <li className={`health__row health__row--${tone}`}>
      <h2 className="health__name">
        <span className={`dot dot--${tone}`} aria-hidden="true" />
        {client.displayName}
      </h2>
      <p className="health__detail">{detail}</p>
    </li>
  );
}

function statusCopy(client: DemoClient, tone: ClientHealthTone): string {
  const when = client.lastSeenAt ? formatTime(client.lastSeenAt) : null;

  if (tone === 'ok') {
    return when ? `Läste din profil via MCP ${when}.` : 'Läste din profil via MCP.';
  }
  if (tone === 'warn') {
    return when
      ? `Fick din profil ${when}, men bara när modellen själv frågade.`
      : 'Fick din profil, men bara när modellen själv frågade.';
  }
  return 'Har aldrig fått din profil.';
}

function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString('sv-SE', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  });
}
