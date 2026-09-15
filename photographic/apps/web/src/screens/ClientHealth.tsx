import { Wordmark } from '../components/Wordmark.js';
import {
  DEMO_CLIENTS,
  clientHealthTone,
  type ClientHealthTone,
  type DemoClient,
} from '../data/demo.js';

/**
 * Honesty feature: which connected AIs actually received the personal profile.
 * Hero surface, not a settings page — one calm row of cards, Swedish, no violet
 * except the wordmark.
 */
export function ClientHealth() {
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

      <div className="health" role="list">
        {DEMO_CLIENTS.map((client) => (
          <ClientCard key={client.id} client={client} />
        ))}
      </div>
    </article>
  );
}

function ClientCard({ client }: { client: DemoClient }) {
  const tone = clientHealthTone(client);
  const detail = statusCopy(client, tone);

  return (
    <article className={`health-card health-card--${tone}`} role="listitem">
      <h2 className="health-card__name">
        <span className={`dot dot--${tone}`} aria-hidden="true" />
        {client.displayName}
      </h2>
      <p className="health-card__detail">{detail}</p>
    </article>
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
