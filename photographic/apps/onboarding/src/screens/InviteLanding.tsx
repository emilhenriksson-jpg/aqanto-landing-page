import { useEffect, useState } from 'react';

import type { Api, InvitePreview } from '../api.js';

/**
 * The growth loop, so the content comes before the form. A signup wall as the first
 * screen is where an invite-driven product dies: the person has no reason to trust it
 * yet, and asking for an address before showing anything is asking them to guess.
 */
export function InviteLanding({
  api,
  token,
  onJoin,
}: {
  api: Api;
  token: string;
  onJoin: () => void;
}) {
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api
      .peekInvite(token)
      .then((result) => {
        if (!cancelled) setPreview(result);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'Inbjudan gäller inte längre.');
      });
    return () => {
      cancelled = true;
    };
  }, [api, token]);

  if (error) {
    return (
      <div className="narrow">
        <h1>Inbjudan gäller inte längre</h1>
        <p className="lede">{error}</p>
      </div>
    );
  }

  if (!preview) {
    return (
      <div className="narrow">
        <div className="card" style={{ height: 180 }} aria-busy="true" />
      </div>
    );
  }

  return (
    <div className="narrow">
      <p className="meta">
        {preview.invitedByName ? `${preview.invitedByName} bjöd in dig till` : 'Du är inbjuden till'}
      </p>
      <h1>{preview.room.title}</h1>
      {preview.room.description && <p className="lede">{preview.room.description}</p>}

      {preview.preview && (
        <div className="card card--hero" style={{ marginBottom: 32 }}>
          <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{preview.preview}</p>
        </div>
      )}

      <button type="button" className="btn btn--primary btn--block" onClick={onJoin}>
        Gå med
      </button>
      <p className="meta" style={{ marginTop: 14 }}>
        Du får ett eget personligt rum på samma gång. Det ser ingen annan.
      </p>
    </div>
  );
}
