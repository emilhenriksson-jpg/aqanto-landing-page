import { useEffect, useState } from 'react';

import type { Api, ClientHealthEntry } from '../api.js';

/**
 * The honesty feature, and a hero rather than a settings page.
 *
 * We cannot force every AI client to read the personal room. Showing plainly which
 * ones did is the only promise we can actually keep, and it is more convincing than
 * claiming universal support would be.
 */
export function Health({ api }: { api: Api }) {
  const [entries, setEntries] = useState<ClientHealthEntry[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api
      .health()
      .then((result) => {
        if (!cancelled) setEntries(result);
      })
      .catch(() => {
        if (!cancelled) setEntries([]);
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  if (!entries || entries.length === 0) return null;

  return (
    <section className="section">
      <h2>Dina kopplade AI:er</h2>
      <div className="health">
        {entries.map((entry) => {
          const tone = !entry.profileDelivered ? 'bad' : entry.degraded ? 'warn' : 'ok';

          return (
            <article className="card" key={entry.agentClient}>
              <h3>
                <span className={`dot dot--${tone}`} aria-hidden="true" />
                {entry.displayName}
              </h3>
              <p className="meta" style={{ margin: '8px 0 0' }}>
                {tone === 'ok' && `Läste din profil ${formatTime(entry.lastSeenAt)}.`}
                {tone === 'warn' &&
                  `Fick din profil ${formatTime(entry.lastSeenAt)}, men bara när modellen själv frågade.`}
                {tone === 'bad' && 'Har aldrig fått din profil.'}
              </p>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
}
