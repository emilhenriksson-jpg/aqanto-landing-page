import { useState } from 'react';

import type { ClientDescriptor, ConnectAction } from '@photographic/connect';

import { CopyButton } from './CopyButton.js';

const CAPABILITY_LABEL: Record<ClientDescriptor['capability'], string> = {
  guaranteed: 'Alltid',
  deterministic: 'Läser automatiskt',
  best_effort: 'När modellen frågar',
  manual: 'Manuellt',
};

function Action({ action, primary }: { action: ConnectAction; primary: boolean }) {
  if (action.type === 'deeplink') {
    return (
      <a
        className={primary ? 'btn btn--primary btn--block' : 'btn'}
        href={action.url}
        style={{ textAlign: 'center', textDecoration: 'none', display: 'block' }}
      >
        {action.label}
      </a>
    );
  }

  if (action.type === 'command') {
    return (
      <div className="stack" style={{ gap: 10 }}>
        <div className="code-line">
          <code>{action.command}</code>
        </div>
        <CopyButton value={action.command} label={action.label} variant={primary ? 'primary' : 'default'} />
      </div>
    );
  }

  return <CopyButton value={action.value} label={action.label} variant={primary ? 'primary' : 'default'} />;
}

export function ClientCard({
  client,
  onConnected,
}: {
  client: ClientDescriptor;
  /** Called when the person says they have done it, which starts verification. */
  onConnected: (client: ClientDescriptor) => void;
}) {
  const [showMore, setShowMore] = useState(false);

  return (
    <article className="card">
      <header className="client__head">
        <h3>{client.displayName}</h3>
        <span className={client.oneClick ? 'chip chip--oneclick' : 'chip'}>
          {client.oneClick ? 'Ett klick' : CAPABILITY_LABEL[client.capability]}
        </span>
      </header>

      <div className="stack" style={{ gap: 18 }}>
        <Action action={client.primary} primary />

        <ol className="steps">
          {client.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>

        {client.caveats.length > 0 && (
          <ul className="caveats">
            {client.caveats.map((caveat) => (
              <li className="caveat" key={caveat}>
                <span>{caveat}</span>
              </li>
            ))}
          </ul>
        )}

        <button type="button" className="btn btn--block" onClick={() => onConnected(client)}>
          Jag har gjort det
        </button>

        {client.secondary.length > 0 && (
          <div className="stack" style={{ gap: 10 }}>
            <button type="button" className="btn btn--quiet" onClick={() => setShowMore(!showMore)}>
              {showMore ? 'Färre sätt' : 'Fler sätt'}
            </button>
            {showMore &&
              client.secondary.map((action, index) => (
                <Action action={action} primary={false} key={`${action.type}-${index}`} />
              ))}
          </div>
        )}
      </div>
    </article>
  );
}
