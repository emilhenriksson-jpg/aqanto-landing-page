import { useState } from 'react';

import { checkSwedishMobile, MOBILE_EXAMPLE } from '@photographic/connect/phone';

import type { Api, RequestCodeResponse, VerifyCodeResponse } from '../api.js';

/**
 * No passwords. A password is one more thing to invent before finding out whether the
 * product is any good, and "forgot password" is a whole subsystem to build and secure
 * for no benefit.
 *
 * One field, and it is a mobile number. The code arrives by SMS and only by SMS, so
 * there is nothing here to choose between: a channel picker whose second option cannot
 * deliver is a door drawn on a wall.
 *
 * `checkSwedishMobile` is the same function the endpoint validates with, imported rather
 * than restated, so the sentence a person reads before the round trip is the sentence
 * they would have got after it.
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
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function request(event: React.FormEvent) {
    event.preventDefault();

    // Checked here, and never corrected in the field: the number stays exactly as the
    // person wrote it, because it is theirs and they know how it goes.
    const checked = checkSwedishMobile(phone);
    if (!checked.ok) {
      setError(checked.message);
      return;
    }

    setBusy(true);
    setError(null);
    try {
      setPending(
        await api.requestCode({
          phone: checked.e164,
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
          Skriv in ditt mobilnummer. Du får en kod med SMS. Inget lösenord.
        </p>

        <form className="stack" style={{ gap: 14 }} onSubmit={request}>
          <input
            className="field"
            aria-label="Mobilnummer"
            type="tel"
            inputMode="tel"
            placeholder={MOBILE_EXAMPLE}
            autoComplete="tel"
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
          />
          <button
            type="submit"
            className="btn btn--primary btn--block"
            disabled={busy || phone.trim().length === 0}
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
          Använd ett annat nummer
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
