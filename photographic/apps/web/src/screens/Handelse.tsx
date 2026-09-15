import { Link, useParams } from 'react-router-dom';

import type { MemoryEventDetailDto } from '../api/index.js';
import { CalmState, LoadingState } from '../components/CalmState.js';
import { Wordmark } from '../components/Wordmark.js';
import { DEMO_EVENT_DETAIL, EVENT_GLYPH, EVENT_LABEL } from '../data/demo.js';
import { clientLabel, loadEventFromApi } from '../data/load.js';
import { useRoomData } from '../hooks/useRoomData.js';

/**
 * One memory event, zoomed: dag → minneshändelse → källa.
 *
 * The last step of the zoom is the one people actually ask for. "Hur vet du det om mig?"
 * is not answered by a timestamp and a client name — it is answered by the conversation
 * the fact came out of, which is why the source block names the session and everything
 * else that came out of it.
 */
export function Handelse() {
  const { seq } = useParams<{ seq: string }>();
  const parsed = Number(seq);

  const state = useRoomData(
    `handelse:${seq}`,
    () => DEMO_EVENT_DETAIL,
    () => loadEventFromApi(parsed),
  );

  if (state.status === 'loading') return <LoadingState label="Hämtar händelsen…" />;
  if (state.status === 'error') {
    return <CalmState title="Minneshändelse" message={state.message} />;
  }

  return <HandelseReady detail={state.data} />;
}

function HandelseReady({ detail }: { detail: MemoryEventDetailDto }) {
  const { entry, source } = detail;
  const when = new Date(entry.occurredAt).toLocaleString('sv-SE', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  const day = entry.occurredAt.slice(0, 10);

  return (
    <article className="page page--handelse">
      <header className="page-head">
        <Wordmark />
        <h1 className="page-head__title">
          <span aria-hidden="true">{EVENT_GLYPH[entry.kind]} </span>
          {EVENT_LABEL[entry.kind]}
        </h1>
        <p className="page-head__lede">
          {when} · {entry.provenance.roomTitle}
        </p>
      </header>

      <section className="section-block" aria-labelledby="vad">
        <h2 className="section-block__title" id="vad">
          Vad som hände
        </h2>
        <p className="day__text">
          {entry.redacted ? 'Texten är permanent raderad.' : entry.body}
        </p>
        {entry.previousBody && (
          <p className="day__previous">
            <span className="meta">Tidigare:</span> {entry.previousBody}
          </p>
        )}
        {detail.currentBody && detail.currentBody !== entry.body && (
          <p className="day__why">Minnet säger nu: {detail.currentBody}</p>
        )}
        {detail.trash && (
          <p className="meta">
            Ligger i papperskorgen. Försvinner permanent om {detail.trash.daysRemaining} dagar.
          </p>
        )}
      </section>

      {/*
        The six questions from section 4 of the scope, as a list rather than as prose, so
        it is obvious when one of them cannot be answered.
      */}
      <section className="section-block" aria-labelledby="proveniens">
        <h2 className="section-block__title" id="proveniens">
          Hur vi vet det
        </h2>
        <dl className="provenance">
          <Fact term="När vi lärde oss det" value={when} />
          <Fact
            term="Varifrån"
            value={source ? source.label : 'Okänd källa'}
          />
          <Fact
            term="Vilken AI som skrev det"
            value={
              entry.provenance.agentClient
                ? clientLabel(entry.provenance.agentClient)
                : entry.provenance.actorName ?? 'Okänd klient'
            }
          />
          <Fact
            term="Var det sparades"
            value={`${entry.provenance.roomTitle}${
              entry.provenance.roomKind === 'personal' ? ' (privat)' : ' (delat rum)'
            }`}
          />
          <Fact term="Varför där" value={entry.provenance.motivation ?? 'Ingen motivering angavs'} />
          <Fact
            term="Har det ändrats"
            value={entry.provenance.changed ? 'Ja, det har korrigerats senare' : 'Nej'}
          />
          <Fact
            term="Godkändes av dig"
            value={entry.provenance.wasApproved ? 'Ja' : entry.provenance.explicit ? 'Du bad om det' : 'Nej, sparades automatiskt'}
          />
        </dl>
      </section>

      {detail.revisions.length > 1 && (
        <section className="section-block" aria-labelledby="historik">
          <h2 className="section-block__title" id="historik">
            Varje version
          </h2>
          <ul className="day">
            {detail.revisions.map((revision) => (
              <li className="day__row" key={revision.seq}>
                <div className="day__body">
                  <p className="meta">
                    {new Date(revision.at).toLocaleDateString('sv-SE', {
                      day: 'numeric',
                      month: 'short',
                    })}
                  </p>
                  <p className="day__text">{revision.body ?? 'Texten är permanent raderad.'}</p>
                  {revision.previousBody && (
                    <p className="day__previous">
                      <span className="meta">Ersatte:</span> {revision.previousBody}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/*
        The source, opened. One Claude session that wrote four things is one conversation,
        which is how the person remembers it — a label alone would not be a place to go
        back to.
      */}
      {source && (
        <section className="section-block" aria-labelledby="kalla">
          <h2 className="section-block__title" id="kalla">
            Originalkällan
          </h2>
          <p className="day__text">{source.label}</p>
          {source.at && (
            <p className="meta">
              Började {new Date(source.at).toLocaleString('sv-SE')}
              {source.transport ? ` · ${source.transport}` : ''}
            </p>
          )}
          {source.uri && (
            <p>
              <a className="day__zoom" href={source.uri}>
                Öppna originalet
              </a>
            </p>
          )}

          {source.alsoFromHere.length > 0 && (
            <>
              <p className="meta">Detta kom också härifrån:</p>
              <ul className="day">
                {source.alsoFromHere.map((also) => (
                  <li className="day__row" key={also.seq}>
                    <div className="day__body">
                      <p className="day__text">{also.body ?? 'Texten är permanent raderad.'}</p>
                      <p className="day__foot">
                        {also.shortId && <span className="mono">{also.shortId}</span>}
                        <Link className="day__zoom" to={`/kalender/handelse/${also.seq}`}>
                          Visa
                        </Link>
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      <p className="page-foot">
        <Link to={`/kalender/${day}`} className="page-foot__link">
          Tillbaka till dagen
        </Link>
      </p>
    </article>
  );
}

function Fact({ term, value }: { term: string; value: string }) {
  return (
    <div className="provenance__row">
      <dt className="meta">{term}</dt>
      <dd>{value}</dd>
    </div>
  );
}
