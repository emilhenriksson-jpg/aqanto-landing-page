import { useState } from 'react';

import type { ClientDescriptor } from '@photographic/connect';

import type { Api, VerifyCodeResponse } from './api.js';
import { Approve } from './screens/Approve.js';
import { Connect } from './screens/Connect.js';
import { Health } from './screens/Health.js';
import { InviteLanding } from './screens/InviteLanding.js';
import { Landing } from './screens/Landing.js';
import { Name } from './screens/Name.js';
import { Signup } from './screens/Signup.js';
import { Verify } from './screens/Verify.js';

export type Step =
  /** `/start`: what the apex hostname should serve, for someone with no account yet. */
  | { name: 'landing'; notice?: string; returnTo?: string }
  | { name: 'invite'; token: string }
  | { name: 'signup'; inviteToken?: string }
  /** First sign-in only — skippable, and never shown again after this session. */
  | { name: 'name' }
  | { name: 'connect' }
  | { name: 'verify'; client: ClientDescriptor }
  /** Arrived by redirect from an AI client's authorization request. */
  | { name: 'approve'; requestId: string };

export function App({
  api,
  initial,
  navigate,
}: {
  api: Api;
  initial?: Step;
  /** Passed through to the consent screen, which is the only place that leaves the app. */
  navigate?: (url: string) => void;
}) {
  const [step, setStep] = useState<Step>(initial ?? { name: 'signup' });
  const [joined, setJoined] = useState<VerifyCodeResponse['joinedRoom']>(null);
  // A landing page first passes this on to `/login`; read it there too, after that real
  // navigation remounts the app. Only a same-origin path can survive the boundary.
  const returnTo =
    initial?.name === 'landing' ? initial.returnTo : returnPathFromLocation();

  /** Leaving the app is a real navigation, so the URL matches the screen afterwards. */
  const go = navigate ?? ((url: string) => window.location.assign(url));

  return (
    <div className={step.name === 'invite' ? 'shell shell--invite' : 'shell'}>
      <div className="wordmark">
        <span className="dot" aria-hidden="true" />
        Photographic
      </div>

      {step.name === 'landing' && (
        <Landing
          onLogin={() => go(returnTo ? `/login?fran=${encodeURIComponent(returnTo)}` : '/login')}
          {...(step.notice ? { notice: step.notice } : {})}
        />
      )}

      {step.name === 'invite' && (
        <InviteLanding
          api={api}
          token={step.token}
          onJoin={() => setStep({ name: 'signup', inviteToken: step.token })}
        />
      )}

      {step.name === 'signup' && (
        <Signup
          api={api}
          {...(step.inviteToken ? { inviteToken: step.inviteToken } : {})}
          onDone={(result) => {
            api.setSession(result.session.token);
            setJoined(result.joinedRoom);
            // First sign-in only. A returning person already decided — skipped it or set
            // it from the account screen — and asking again would be the wall the name
            // prompt is explicitly not allowed to be.
            if (!result.created && returnTo) {
              go(returnTo);
              return;
            }
            setStep(result.created ? { name: 'name' } : { name: 'connect' });
          }}
        />
      )}

      {step.name === 'name' && <Name api={api} onDone={() => setStep({ name: 'connect' })} />}

      {step.name === 'approve' && (
        <Approve api={api} requestId={step.requestId} {...(navigate ? { navigate } : {})} />
      )}

      {step.name === 'connect' && (
        <>
          {joined && (
            <div className="card card--tinted" style={{ marginBottom: 40 }}>
              Du är med i {joined.title}. Koppla din AI så kan den läsa rummet.
            </div>
          )}
          <Connect api={api} onVerify={(client) => setStep({ name: 'verify', client })} />
          <Health api={api} />
        </>
      )}

      {step.name === 'verify' && (
        <div className="narrow">
          <Verify api={api} client={step.client} onDone={() => setStep({ name: 'connect' })} />
        </div>
      )}
    </div>
  );
}

function returnPathFromLocation(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const value = new URLSearchParams(window.location.search).get('fran');
  if (!value || !value.startsWith('/') || value.startsWith('//')) return undefined;
  return value;
}
