import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';

import { isDemoMode, setFirstName as saveFirstNameApi, signOut } from '../api/index.js';
import { CalmState, LoadingState } from '../components/CalmState.js';
import { Wordmark } from '../components/Wordmark.js';
import { loadAccountDemo } from '../data/demo.js';
import { calmErrorMessage, loadAccountStateFromApi, type AccountState } from '../data/load.js';
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
 * The first name sits here too, and on the same argument. Skipping it at sign-in is a real
 * option, so "I would like to be named now" needs somewhere to happen; a person who never
 * set one otherwise has no way to stop a shared room counting them instead of naming them.
 *
 * It arrived as a second `/konto` screen on its own branch, which is how two correct pieces
 * of work end up as one route rendering one of them. One screen carries all three, because
 * they are the same question — what is mine, how do I take it, how do I leave — and a person
 * looking for one will be looking in the place the others are.
 *
 * Deliberately not a settings hub beyond that. Papperskorg, Historik and Kompass are reached
 * from the foot of the start screen, which is a choice `App.tsx` records, and repeating them
 * here would be a second navigation to maintain rather than a discovery.
 */
export function Konto() {
  const state = useRoomData(
    'konto',
    (): AccountState => ({ deletion: null, ...loadAccountDemo() }),
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
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);

  async function endSession() {
    setSigningOut(true);
    setSignOutError(null);
    try {
      if (!isDemoMode()) await signOut();
      window.location.assign('/start?orsak=utloggad');
    } catch {
      setSignOutError('Kunde inte logga ut just nu. Försök igen.');
      setSigningOut(false);
    }
  }

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

      <FirstNameField initial={account.firstName} />

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

      <div className="konto-session">
        <button type="button" className="btn btn--quiet" disabled={signingOut} onClick={() => void endSession()}>
          {signingOut ? 'Loggar ut…' : 'Logga ut'}
        </button>
        {signOutError ? <p className="meta" role="alert">{signOutError}</p> : null}
      </div>

      <footer className="page-foot">
        <Link to="/" className="page-foot__link">
          Tillbaka till ditt rum
        </Link>
      </footer>
    </article>
  );
}

/**
 * One field, because it is the one thing this section exists to let a person decide.
 *
 * Arriving with nothing set is an ordinary state rather than an error — skipping the name
 * at sign-in is supported — so the status line says "Inget förnamn angett än" and never
 * renders blank, `undefined`, or a stray comma waiting for a name that is not there.
 */
function FirstNameField({ initial }: { initial: string | null }) {
  const [firstName, setFirstNameField] = useState(initial ?? '');
  const [saved, setSaved] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    // `save` already catches everything itself and reports it through `error`, so this
    // never actually rejects — the empty `.catch` exists only to satisfy
    // `no-floating-promises`, which this repo runs with `ignoreVoid: false` on purpose.
    void save().catch(() => {});
  }

  async function save() {
    const trimmed = firstName.trim();
    if (!trimmed) return;

    setBusy(true);
    setError(null);
    try {
      if (isDemoMode()) {
        setSaved(trimmed);
      } else {
        const result = await saveFirstNameApi(trimmed);
        setSaved(result.firstName);
      }
    } catch (cause) {
      setError(calmErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="account-name">
      <p className="page-head__lede">
        Ditt förnamn används så att ett delat rum kan säga vem som skrev något, i stället för
        att bara räkna hur många ni är — ingenting annat ändras av det.
      </p>

      <form className="account-form" onSubmit={onSubmit}>
        <label className="meta" htmlFor="account-first-name">
          Förnamn
        </label>
        <input
          id="account-first-name"
          className="field"
          type="text"
          autoComplete="given-name"
          placeholder="Förnamn"
          value={firstName}
          onChange={(event) => setFirstNameField(event.target.value)}
        />
        <button
          type="submit"
          className="btn btn--brand"
          disabled={busy || firstName.trim().length === 0}
        >
          {busy ? 'Sparar' : 'Spara'}
        </button>
      </form>

      <p className="meta" role="status">
        {saved ? `Sparat som ${saved}.` : 'Inget förnamn angett än.'}
      </p>

      {error && (
        <p className="meta" role="alert" style={{ marginTop: 16, color: 'var(--bad)' }}>
          {error}
        </p>
      )}
    </section>
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
