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

  if (state.status === 'loading') return <LoadingState label="Hämtar dina AI:er…" />;
  if (state.status === 'error') {
    return <CalmState title="Dina AI:er" message={state.message} />;
  }

  return (
    <article className="page page--health">
      <header className="page-head page-head--health">
        <Wordmark large />
        <h1 className="page-head__title">Dina AI:er</h1>
        <p className="page-head__lede">
          Här ser du vilka AI:er som har fått ditt minne. En leverans visar att minnet
          skickades, inte att varje svar använder det.
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

  // The disconnect is the answer to a question the person asked by pressing a button, so
  // it is said plainly and in the past tense. The server really does revoke the token
  // family — verified against the live host — and this row is the only place that fact
  // was invisible, which for a control over who reads your memory is the same experience
  // as it not having worked.
  if (tone === 'revoked') {
    return when
      ? `Frånkopplad. Kom åt ditt minne senast ${when}, men kan inte längre.`
      : 'Frånkopplad. Kan inte längre komma åt ditt minne.';
  }
  if (tone === 'ok') {
    return when ? `Fick ditt minne via kopplingen ${when}.` : 'Fick ditt minne via kopplingen.';
  }
  if (tone === 'warn') {
    return when
      ? `Hämtade ditt minne ${when} under ett samtal.`
      : 'Hämtade ditt minne under ett samtal.';
  }
  return 'Ingen bekräftad leverans ännu.';
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'vid okänd tid';
  return date.toLocaleString('sv-SE', { dateStyle: 'short', timeStyle: 'short' });
}
