/**
 * The one screen where a person gives an AI access to their memory.
 *
 * It is reached by redirect: a client sent them to `/login?auth_request=...` and is
 * waiting on a callback. So the two failure modes that matter are being sent back with
 * nothing, and being sent back to somewhere they did not intend — and the second one is
 * already impossible by the time this renders, because the authorization server fixed the
 * redirect URI and the PKCE challenge before issuing the id in the URL. Nothing this page
 * does can move where the code goes.
 *
 * Which leaves this screen with one job: tell the person what they are about to allow,
 * clearly enough that saying no is a real option.
 */

import { useEffect, useState } from 'react';

import type { Api, AuthorizationRequest, VerifyCodeResponse } from '../api.js';
import { Signup } from './Signup.js';

/**
 * Scopes in words.
 *
 * A person cannot consent to `memory.write`. Anything unrecognised is shown as itself
 * rather than dropped: a capability the person was not told about is worse than an ugly
 * line, and a silent omission is how a consent screen becomes a formality.
 */
const SCOPE_LABELS: Record<string, string> = {
  'memory.read': 'Läsa det du sparat',
  'memory.write': 'Spara nytt åt dig',
  'rooms.read': 'Läsa rum du är med i',
  'profile.read': 'Se vem du är',
  'offline_access': 'Fortsätta fungera utan att du loggar in varje gång',
};

type State =
  | { name: 'loading' }
  | { name: 'gone'; message: string }
  | { name: 'ready'; request: AuthorizationRequest }
  | { name: 'answering'; request: AuthorizationRequest };

export function Approve({
  api,
  requestId,
  navigate = (url) => window.location.assign(url),
}: {
  api: Api;
  requestId: string;
  /** Overridden in tests so the redirect target can be asserted rather than followed. */
  navigate?: (url: string) => void;
}) {
  const [state, setState] = useState<State>({ name: 'loading' });
  const [signedIn, setSignedIn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;

    api
      .describeAuthorization(requestId)
      .then((request) => {
        if (live) setState({ name: 'ready', request });
      })
      .catch((cause: unknown) => {
        if (!live) return;
        setState({
          name: 'gone',
          message:
            cause instanceof Error
              ? cause.message
              : 'Förfrågan finns inte längre. Börja om från din AI.',
        });
      });

    return () => {
      live = false;
    };
  }, [api, requestId]);

  useEffect(() => {
    let live = true;
    void api.probeSession().then((ok) => {
      if (live && ok) setSignedIn(true);
    });
    return () => {
      live = false;
    };
  }, [api]);

  async function answer(approved: boolean) {
    if (state.name !== 'ready') return;
    setState({ name: 'answering', request: state.request });
    setError(null);

    try {
      const { redirectUrl } = await api.answerAuthorization({ requestId, approved });
      // The URL comes from the server, never built here. It is the one the client
      // registered, and a page that assembled its own would be a page that could be
      // talked into assembling someone else's.
      navigate(redirectUrl);
    } catch (cause) {
      setState({ name: 'ready', request: state.request });
      setError(cause instanceof Error ? cause.message : 'Något gick fel.');
    }
  }

  if (state.name === 'loading') {
    return (
      <div className="narrow">
        <p className="lede">Hämtar förfrågan…</p>
      </div>
    );
  }

  if (state.name === 'gone') {
    return (
      <div className="narrow">
        <h1>Förfrågan gäller inte längre</h1>
        <p className="lede">{state.message}</p>
        <p className="meta">
          Gå tillbaka till din AI och försök koppla Photographic igen. Ingen åtkomst gavs.
        </p>
      </div>
    );
  }

  const { request } = state;

  if (!signedIn) {
    return (
      <div className="narrow">
        <h1>Logga in för att fortsätta</h1>
        <p className="lede">
          <strong>{request.clientName}</strong> vill komma åt ditt minne. Logga in först, så får
          du se exakt vad det innebär.
        </p>

        <Signup
          api={api}
          onDone={(result: VerifyCodeResponse) => {
            api.setSession(result.session.token);
            setSignedIn(true);
          }}
        />
      </div>
    );
  }

  const busy = state.name === 'answering';

  return (
    <div className="narrow">
      <h1>Ge {request.clientName} åtkomst?</h1>
      <p className="lede">
        Det här är din AI som ber om att få läsa och skriva i ditt minne. Du kan ta bort
        åtkomsten när du vill.
      </p>

      <div className="card" style={{ marginBottom: 28 }}>
        <ul className="grants">
          {request.scopes.map((scope) => (
            <li key={scope} className="grant">
              {SCOPE_LABELS[scope] ?? scope}
            </li>
          ))}
        </ul>
      </div>

      {/*
        The name above came from an open registration endpoint, so anyone can register a
        client called "Photographic Official". Saying where it came from is the only
        honest thing to do: we cannot verify it, and a person who knows that reads it
        differently.
      */}
      <p className="meta" style={{ marginBottom: 28 }}>
        Namnet är det som appen själv uppgav. Känner du inte igen det, neka.
      </p>

      <div className="stack" style={{ gap: 12 }}>
        <button
          type="button"
          className="btn btn--primary btn--block"
          disabled={busy}
          onClick={() => void answer(true)}
        >
          {busy ? 'Kopplar' : `Ge ${request.clientName} åtkomst`}
        </button>
        <button
          type="button"
          className="btn btn--quiet"
          disabled={busy}
          onClick={() => void answer(false)}
        >
          Neka
        </button>
      </div>

      {error && (
        <p className="meta" role="alert" style={{ marginTop: 16, color: 'var(--bad)' }}>
          {error}
        </p>
      )}
    </div>
  );
}
