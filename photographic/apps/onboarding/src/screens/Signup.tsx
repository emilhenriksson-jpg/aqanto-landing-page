import { useState } from 'react';

import type { Api, RequestCodeResponse, VerifyCodeResponse } from '../api.js';

/**
 * No passwords. A password is one more thing to invent before finding out whether the
 * product is any good, and "forgot password" is a whole subsystem to build and secure
 * for no benefit.
 */
export function Signup({
  api,
  inviteToken,
  onDone,
}: {
  api: Api;
  inviteToken?: string;
  onDone: (result: VerifyCodeResponse) => void;
}) {
  const [pending, setPending] = useState<RequestCodeResponse | null>(null);
  const [destination, setDestination] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function request(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const looksLikeEmail = destination.includes('@');
      setPending(
        await api.requestCode({
          ...(looksLikeEmail ? { email: destination } : { phone: destination }),
          ...(inviteToken ? { inviteToken } : {}),
        }),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Något gick fel.');
    } finally {
      setBusy(false);
    }
  }

  async function verify(event: React.FormEvent) {
    event.preventDefault();
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      onDone(await api.verifyCode({ requestId: pending.requestId, code }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Något gick fel.');
    } finally {
      setBusy(false);
    }
  }

  if (!pending) {
    return (
      <div className="narrow">
        <h1>Ditt minne, inte modellens.</h1>
        <p className="lede">
          Skriv in din e-post eller ditt mobilnummer. Inget lösenord.
        </p>

        <form className="stack" style={{ gap: 14 }} onSubmit={request}>
          <input
            className="field"
            aria-label="E-post eller mobilnummer"
            placeholder="du@exempel.se"
            autoComplete="email"
            value={destination}
            onChange={(event) => setDestination(event.target.value)}
          />
          <button
            type="submit"
            className="btn btn--primary btn--block"
            disabled={busy || destination.trim().length === 0}
          >
            {busy ? 'Skickar' : 'Fortsätt'}
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

  return (
    <div className="narrow">
      <h1>Skriv in koden</h1>
      <p className="lede">
        Vi skickade en sexsiffrig kod till {pending.destinationHint}.
      </p>

      <form className="stack" style={{ gap: 14 }} onSubmit={verify}>
        <input
          className="field field--code"
          aria-label="Kod"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          placeholder="······"
          value={code}
          onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
        />
        <button type="submit" className="btn btn--primary btn--block" disabled={busy || code.length < 6}>
          {busy ? 'Kontrollerar' : 'Fortsätt'}
        </button>
        <button type="button" className="btn btn--quiet" onClick={() => setPending(null)}>
          Använd en annan adress
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
