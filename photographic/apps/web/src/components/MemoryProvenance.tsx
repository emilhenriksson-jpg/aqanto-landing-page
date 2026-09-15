import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { isDemoMode } from '../api/index.js';
import { DEMO_PROVENANCE, type ProvenanceAnswer, type RoomKind } from '../data/demo.js';
import { calmErrorMessage, loadProvenanceFromApi } from '../data/load.js';

/**
 * "Hur vet du det om mig?", answered about one memory.
 *
 * The question this product exists to answer, and until now it could only be asked about
 * a day in the calendar. It is the difference between a memory a person trusts and a
 * system that unnervingly knows things, so it is one tap from the line itself and it
 * answers in sentences rather than in fields.
 *
 * Fetched when opened rather than with the room: a profile of forty lines would otherwise
 * make forty requests to answer a question nobody asked yet.
 */
export function MemoryProvenance({
  id,
  shortId,
  roomId,
  roomKind,
}: {
  id: string;
  shortId: string;
  roomId?: string;
  roomKind: RoomKind;
}) {
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'ready'; answer: ProvenanceAnswer }
    | { status: 'error'; message: string }
  >(() =>
    isDemoMode() ? demoState(shortId, roomKind) : { status: 'loading' },
  );

  useEffect(() => {
    if (isDemoMode()) {
      setState(demoState(shortId, roomKind));
      return;
    }

    let cancelled = false;
    setState({ status: 'loading' });

    void loadProvenanceFromApi(shortId, roomId, roomKind)
      .then((answer) => {
        if (!cancelled) setState({ status: 'ready', answer });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ status: 'error', message: calmErrorMessage(error) });
      });

    return () => {
      cancelled = true;
    };
  }, [shortId, roomId, roomKind]);

  if (state.status === 'loading') {
    return (
      <div className="memory__proof" id={id}>
        <p className="meta">Hämtar ursprunget…</p>
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="memory__proof" id={id}>
        <p className="meta">{state.message}</p>
      </div>
    );
  }

  const { answer } = state;

  return (
    <div className="memory__proof" id={id}>
      <dl className="provenance">
        <Fact term="När" value={answer.when} />
        <Fact term="Varifrån" value={answer.sourceLabel ?? 'Källan är inte känd'} />
        <Fact term="Vem skrev in det" value={answer.who} />
        <Fact
          term="Var det ligger"
          value={`${answer.roomTitle}${answer.roomKind === 'personal' ? ' (privat)' : ' (delat rum)'}`}
        />
        <Fact term="Varför där" value={answer.motivation ?? 'Ingen motivering angavs'} />
        <Fact
          term="Godkänt av dig"
          value={answer.approvedByName ? 'Ja, du sa ja till det' : 'Nej, det sparades automatiskt'}
        />
        {answer.changed ? <Fact term="Ändrat sedan dess" value="Ja, det har korrigerats" /> : null}
      </dl>

      {answer.seq !== null && (
        <p className="memory__proof-more">
          <Link className="day__zoom" to={`/kalender/handelse/${answer.seq}`}>
            Öppna originalkällan
          </Link>
        </p>
      )}
    </div>
  );
}

/**
 * A row with no answer is a real state, not a bug.
 *
 * Events written before the log carried provenance have nothing to say, and saying
 * "vi vet inte" is the honest version — a confident "okänd källa" formatted like all the
 * other facts reads as an answer when it is the absence of one.
 */
function demoState(
  shortId: string,
  roomKind: RoomKind,
): { status: 'ready'; answer: ProvenanceAnswer } | { status: 'error'; message: string } {
  const answer = DEMO_PROVENANCE[shortId];
  if (!answer) {
    return { status: 'error', message: 'Det här minnet sparades innan vi loggade ursprung.' };
  }
  return { status: 'ready', answer: { ...answer, roomKind } };
}

function Fact({ term, value }: { term: string; value: string }) {
  return (
    <div className="provenance__row">
      <dt className="meta">{term}</dt>
      <dd>{value}</dd>
    </div>
  );
}
