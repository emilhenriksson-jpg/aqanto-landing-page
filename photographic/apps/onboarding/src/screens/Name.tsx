import { useState } from 'react';

import type { Api } from '../api.js';

/**
 * Asked once, right after the code is verified on a brand-new account — never before
 * (a signup wall is where people leave) and never again after this session (a person
 * who skips it sets it later from the account screen, in `apps/web`, not here).
 *
 * Skippable in the literal sense: "Hoppa över" and an empty submit both move on without
 * calling the API at all, so there is genuinely nothing to get stuck on.
 */
export function Name({ api, onDone }: { api: Api; onDone: () => void }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    // `save` already catches everything itself and shows it via `error`, so this never
    // actually rejects — the empty `.catch` exists only to satisfy
    // `no-floating-promises`, which this repo runs with `ignoreVoid: false` on purpose.
    void save().catch(() => {});
  }

  async function save() {
    const trimmed = name.trim();
    if (!trimmed) {
      onDone();
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await api.setFirstName(trimmed);
      onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Något gick fel.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="narrow">
      <h1>Vad heter du?</h1>
      <p className="lede">
        Så att ett delat rum kan säga vem som skrev något, i stället för att bara räkna
        hur många ni är. Frivilligt — du kan ange det senare från kontosidan.
      </p>

      <form className="stack" style={{ gap: 14 }} onSubmit={onSubmit}>
        <input
          className="field"
          aria-label="Förnamn"
          type="text"
          autoComplete="given-name"
          placeholder="Förnamn"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <button type="submit" className="btn btn--primary btn--block" disabled={busy}>
          {busy ? 'Sparar' : 'Fortsätt'}
        </button>
        <button type="button" className="btn btn--quiet" onClick={onDone} disabled={busy}>
          Hoppa över
        </button>
      </form>

      {error && (
        <p className="meta" role="alert" style={{ marginTop: 16, color: 'var(--bad)' }}>
          {error}
        </p>
      )}
    </div>
  );
}
