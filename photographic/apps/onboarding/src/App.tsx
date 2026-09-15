import { useState } from 'react';

import type { ClientDescriptor } from '@photographic/connect';

import type { Api, VerifyCodeResponse } from './api.js';
import { Approve } from './screens/Approve.js';
import { Connect } from './screens/Connect.js';
import { Health } from './screens/Health.js';
import { InviteLanding } from './screens/InviteLanding.js';
import { Landing } from './screens/Landing.js';
import { Signup } from './screens/Signup.js';
import { Verify } from './screens/Verify.js';

export type Step =
  /** `/start`: what the apex hostname should serve, for someone with no account yet. */
  | { name: 'landing' }
  | { name: 'invite'; token: string }
  | { name: 'signup'; inviteToken?: string }
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

  /** Leaving the app is a real navigation, so the URL matches the screen afterwards. */
  const go = navigate ?? ((url: string) => window.location.assign(url));

  return (
    <div className={step.name === 'invite' ? 'shell shell--invite' : 'shell'}>
      <div className="wordmark">
        <span className="dot" aria-hidden="true" />
        Photographic
      </div>

      {step.name === 'landing' && <Landing onLogin={() => go('/login')} />}

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
            // `next` is always `connect`: creating an account and connecting an AI are
            // one flow, so there is no dashboard in between.
            setStep({ name: 'connect' });
          }}
        />
      )}

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
