import { Link } from 'react-router-dom';

import { CalmState, LoadingState } from '../components/CalmState.js';
import { Wordmark } from '../components/Wordmark.js';
import { loadAccountStateFromApi, type AccountState } from '../data/load.js';
import { useRoomData } from '../hooks/useRoomData.js';

/**
 * The account screen, and the reason it exists.
 *
 * Export and permanent deletion were built, tested and first-party gated with no way for a
 * person to press either one: no screen called them, so the two promises that make a memory
 * product trustworthy — that you can take your memory with you, and that you can really
 * leave — were true of the API and false of the product. This screen is where they live, and
 * the rail entry is how they are found.
 *
 * Deliberately not a settings hub. Papperskorg, Historik and Kompass are reached from the
 * foot of the start screen, which is a choice `App.tsx` records, and repeating them here
 * would be a second navigation to maintain rather than a discovery.
 */
export function Konto() {
  const state = useRoomData(
    'konto',
    (): AccountState => ({ deletion: null }),
    () => loadAccountStateFromApi(),
  );

  if (state.status === 'loading') return <LoadingState label="Hämtar ditt konto…" />;
  if (state.status === 'error') {
    return <CalmState title="Konto" message={state.message} />;
  }

  return <KontoReady account={state.data} />;
}

function KontoReady({ account }: { account: AccountState }) {
  const { deletion } = account;

  return (
    <article className="page page--konto">
      <header className="page-head">
        <Wordmark />
        <h1 className="page-head__title">Konto</h1>
        <p className="page-head__lede">
          Två saker som gör minnet ditt: att du kan ta det med dig, och att du kan lämna.
        </p>
      </header>

      {deletion ? (
        <p className="konto-notice">
          Ditt konto raderas{' '}
          {deletion.daysRemaining === 0
            ? 'inom kort'
            : deletion.daysRemaining === 1
              ? 'om 1 dag'
              : `om ${deletion.daysRemaining} dagar`}
          . <Link to="/konto/radera">Avbryt raderingen</Link>
        </p>
      ) : null}

      <ul className="card card--group konto-list">
        <KontoRow
          to="/konto/export"
          title="Ta med ditt minne"
          detail="Ett arkiv med hela din logg och dina filer, läsbart utan Photographic."
        />
        <KontoRow
          to="/konto/radera"
          title="Radera konto"
          detail="Lämna på riktigt — direkt, eller med 30 dagars ångerfrist."
        />
      </ul>

      <footer className="page-foot">
        <Link to="/" className="page-foot__link">
          Tillbaka till ditt rum
        </Link>
      </footer>
    </article>
  );
}

function KontoRow({ to, title, detail }: { to: string; title: string; detail: string }) {
  return (
    <li className="konto-row">
      <Link to={to} className="konto-row__link">
        <span className="konto-row__title">{title}</span>
        <span className="konto-row__detail meta">{detail}</span>
      </Link>
    </li>
  );
}
