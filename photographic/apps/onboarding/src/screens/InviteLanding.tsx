import { SHARED_ROOM_CONSENT } from '@photographic/core';
import { useEffect, useState } from 'react';

import type { Api, InvitePreview } from '../api.js';

/**
 * The growth loop, and the only invite screen in the product now.
 *
 * The content comes before the form: a signup wall as the first screen is where an
 * invite-driven product dies, because the person has no reason to trust it yet and asking
 * for a number before showing anything is asking them to guess.
 *
 * The first viewport is the decision, and it is ordered the way the questions arrive on a
 * phone from someone you trust: who is this from, what am I being let into, and what
 * happens to me if I say yes. The third one is the part that used to sit below the fold and
 * matters most — a shared room keeps what you write in it even after you leave, and the
 * whole justification for that rule is that it was said *before* anybody wrote forty notes
 * into a room. The room's own content sits underneath, where scrolling is a choice.
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

  const invitedBy = preview.invitedByName?.trim() || null;
  const lines = previewLines(preview.preview);

  return (
    <div className="invite narrow">
      <section className="invite__decision">
        {/*
          "Någon" rather than a nameless "Du är inbjuden till" — the same fallback word
          every other unknown-person surface in the product uses (history, disputes, the
          web app's own invite screen), so a person who has not set a name yet reads the
          same way wherever an invite mentions them. The markup around it is the invite
          viewport's, which this branch predates.
        */}
        <p className="invite__from meta">
          {`${invitedBy?.trim() || 'Någon'} bjuder in dig till ett delat rum`}
        </p>
        <h1 className="invite__title">{preview.room.title}</h1>
        {preview.room.description ? (
          <p className="invite__brief">{preview.room.description}</p>
        ) : null}

        {/*
          What happens if you accept, in three lines, above the button. The shared-room rule
          is one of them rather than a paragraph below it: it is the consequence a person
          cannot discover later without feeling tricked.
        */}
        <ul className="invite__what">
          <li>Du ser rummets minne och kan lägga till i det.</li>
          <li>
            Du får ett eget privat rum på samma gång. Det ser ingen annan
            {invitedBy ? `, inte ${invitedBy} heller` : ''}.
          </li>
          <li>Vad du skriver i rummet stannar i rummet, även om du lämnar det.</li>
        </ul>

        <button type="button" className="btn btn--primary btn--block" onClick={onJoin}>
          Gå med
        </button>
        <p className="invite__consent meta">{SHARED_ROOM_CONSENT}</p>
      </section>

      {lines.length > 0 ? (
        <section className="invite__content" aria-labelledby="invite-content">
          <h2 id="invite-content" className="invite__content-title">
            Ur rummet
          </h2>
          <ul className="invite__lines">
            {lines.map((line, index) => (
              <li key={`${index}-${line.slice(0, 12)}`} className="invite__line">
                {line}
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <p className="invite__empty meta">Inget sparat i rummet ännu.</p>
      )}
    </div>
  );
}

/** The preview arrives as newline-separated bodies, capped server-side. */
function previewLines(preview: string | null): string[] {
  if (!preview) return [];
  return preview
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
