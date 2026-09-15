import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';

import { isDemoMode, setFirstName as saveFirstNameApi } from '../api/index.js';
import { CalmState, LoadingState } from '../components/CalmState.js';
import { Wordmark } from '../components/Wordmark.js';
import { loadAccountDemo } from '../data/demo.js';
import { calmErrorMessage, loadAccountFromApi, type AccountView } from '../data/load.js';
import { useRoomData } from '../hooks/useRoomData.js';

/**
 * The account screen: the one place to set a first name later, for anyone who skipped
 * it at sign-in. Not a settings dashboard — one field, because that is the one thing
 * this screen exists to let a person decide for themselves.
 *
 * Skipping at sign-in is a real option (see `apps/onboarding`'s post-verify step), so
 * arriving here with nothing set yet is an expected, ordinary state — not an error.
 */
export function Account() {
  const state = useRoomData('account', loadAccountDemo, loadAccountFromApi);

  if (state.status === 'loading') return <LoadingState label="Hämtar kontot…" />;
  if (state.status === 'error') {
    return <CalmState title="Konto" message={state.message} />;
  }

  return <AccountReady account={state.data} />;
}

function AccountReady({ account }: { account: AccountView }) {
  const [firstName, setFirstNameField] = useState(account.firstName ?? '');
  const [saved, setSaved] = useState(account.firstName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    // `save` already catches everything itself and shows it via `error`, so this never
    // actually rejects — the empty `.catch` exists only to satisfy
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
    <article className="page page--account">
      <header className="page-head">
        <Wordmark />
        <h1 className="page-head__title">Konto</h1>
        <p className="page-head__lede">
          Ditt förnamn används så att ett delat rum kan säga vem som skrev något, i
          stället för att bara räkna hur många ni är — ingenting annat ändras av det.
        </p>
      </header>

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

      <footer className="page-foot">
        <Link to="/" className="page-foot__link">
          Tillbaka till ditt rum
        </Link>
      </footer>
    </article>
  );
}
