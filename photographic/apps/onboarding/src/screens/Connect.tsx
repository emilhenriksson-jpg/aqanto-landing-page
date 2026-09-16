import { useEffect, useState } from 'react';

import type { ClientDescriptor } from '@photographic/connect';

import type { Api, ConnectPayload } from '../api.js';
import { ClientCard } from '../components/ClientCard.js';
import { CopyButton } from '../components/CopyButton.js';

/**
 * Every string per client comes from the payload, never from this file. Adding a client
 * later should mean touching `@photographic/connect` and nothing here, because the
 * per-client quirks are the part that changes.
 */
export function Connect({
  api,
  onVerify,
}: {
  api: Api;
  onVerify: (client: ClientDescriptor) => void;
}) {
  const [payload, setPayload] = useState<ConnectPayload | null>(null);
  const [profile, setProfile] = useState('');

  useEffect(() => {
    let cancelled = false;
    void api.connect().then((result) => {
      if (!cancelled) setPayload(result);
    });
    // The ChatGPT card's fallback pastes the real profile, so fetch it alongside.
    void api
      .renderedProfile()
      .then((rendered) => {
        if (!cancelled) setProfile(rendered);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [api]);

  if (!payload) {
    return (
      <div className="card" style={{ height: 240 }} aria-busy="true" />
    );
  }

  const clients = payload.clients.map((client) =>
    client.id === 'chatgpt' ? withProfileFallback(client, profile) : client,
  );

  return (
    <>
      <section className="section">
        <a href="/chatt" className="btn btn--quiet">Till din start</a>
        <h1>Koppla din AI</h1>
        <p className="lede">{payload.headline}</p>

        <div className="card card--hero url-card">
          <span className="meta">Din adress till Photographic</span>
          <span className="url">{payload.mcpUrl}</span>
          <CopyButton value={payload.mcpUrl} label="Kopiera adressen" variant="primary" />
          <span className="meta">
            Den är ofarlig att dela. Det är inloggningen som avgör vad som är ditt.
          </span>
        </div>
      </section>

      <section className="section">
        <h2>Välj var du vill börja</h2>
        <div className="clients">
          {clients.map((client) => (
            <ClientCard key={client.id} client={client} onConnected={onVerify} />
          ))}
        </div>
      </section>

      <section className="section">
        <h2>Koppla på telefonen</h2>
        <div className="card qr">
          <img src={payload.qrDataUrl} alt="QR-kod till kopplingssidan" />
          <div>
            <p style={{ margin: '0 0 8px' }}>Skanna för att fortsätta i mobilen.</p>
            <p className="meta" style={{ margin: 0 }}>
              Claude-kopplingen läggs in från datorn, men fungerar i mobilappen efteråt.
            </p>
          </div>
        </div>
      </section>
    </>
  );
}

/**
 * The connect package leaves the ChatGPT fallback action's value empty on purpose: it
 * has no way to fetch the rendered profile without doing I/O. Fill it here.
 */
function withProfileFallback(client: ClientDescriptor, profile: string): ClientDescriptor {
  return {
    ...client,
    secondary: client.secondary.map((action) =>
      action.type === 'copy' && action.value === '' ? { ...action, value: profile } : action,
    ),
  };
}
