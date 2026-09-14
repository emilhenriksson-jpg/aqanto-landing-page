import { useState } from 'react';

import type { ClientDescriptor } from '@photographic/connect';

import type { Api, VerifyCodeResponse } from './api.js';
import { Connect } from './screens/Connect.js';
import { Health } from './screens/Health.js';
import { InviteLanding } from './screens/InviteLanding.js';
import { Signup } from './screens/Signup.js';
import { Verify } from './screens/Verify.js';

export type Step =
  | { name: 'invite'; token: string }
  | { name: 'signup'; inviteToken?: string }
  | { name: 'connect' }
  | { name: 'verify'; client: ClientDescriptor };

export function App({ api, initial }: { api: Api; initial?: Step }) {
  const [step, setStep] = useState<Step>(initial ?? { name: 'signup' });
  const [joined, setJoined] = useState<VerifyCodeResponse['joinedRoom']>(null);

  return (
    <div className="shell">
      <div className="wordmark">
        <span className="dot" aria-hidden="true" />
        Photographic
      </div>

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
            setJoined(result.joinedRoom);
            // `next` is always `connect`: creating an account and connecting an AI are
            // one flow, so there is no dashboard in between.
            setStep({ name: 'connect' });
          }}
        />
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
