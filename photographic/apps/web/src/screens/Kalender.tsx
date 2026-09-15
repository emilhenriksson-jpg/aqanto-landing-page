import { Link, useParams, useSearchParams } from 'react-router-dom';

import { isDemoMode } from '../api/config.js';
import { CalmState, LoadingState } from '../components/CalmState.js';
import { Wordmark } from '../components/Wordmark.js';
import {
  DEMO_DAY,
  EVENT_GLYPH,
  EVENT_LABEL,
  type DayEvent,
  type DayView,
} from '../data/demo.js';
import { loadDayFromApi, swedishDayHeading } from '../data/load.js';
import { useRoomData } from '../hooks/useRoomData.js';

/**
 * The calendar day: what Photographic did with what you told it.
 *
 * Not "what did I talk about" — the rooms answer that. This screen answers the question
 * the rest of the product cannot, which is what the system *did* with it: where it went,
 * why there, what it replaced, and who else can now read it.
 *
 * Days only. Week, month and year are derivable from the same log whenever they are
 * wanted, and four screens of summaries over one screen of facts would have been the
 * wrong order to build them in.
 */
export function Kalender() {
  const { date } = useParams<{ date: string }>();
  const [params] = useSearchParams();
  const roomId = params.get('rum') ?? undefined;
  // `/kalender` with no date is today. Demo mode lands on the day the demo data describes,
  // so the screen can be reviewed without a backend.
  const day = date ?? (isDemoMode() ? DEMO_DAY.date : todayInBrowserZone());

  const state = useRoomData(
    `kalender:${day}:${roomId ?? 'alla'}`,
    () => (day === DEMO_DAY.date ? DEMO_DAY : emptyDay(day)),
    () => loadDayFromApi(day, roomId),
  );

  if (state.status === 'loading') return <LoadingState label="Hämtar dagen…" />;
  if (state.status === 'error') return <CalmState title="Kalender" message={state.message} />;

  return <DayReady day={state.data} roomId={roomId} />;
}

/** Today, on the person's own wall clock rather than in UTC. */
function todayInBrowserZone(): string {
  return new Date().toLocaleDateString('sv-SE', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

function emptyDay(date: string): DayView {
  return {
    date,
    heading: swedishDayHeading(date),
    roomTitle: null,
    events: [],
    byOthersCount: 0,
    previousDate: DEMO_DAY.date,
    nextDate: null,
  };
}

function DayReady({ day, roomId }: { day: DayView; roomId: string | undefined }) {
  const link = (date: string) => `/kalender/${date}${roomId ? `?rum=${roomId}` : ''}`;
  const others = day.events.filter((event) => event.byOtherMember);

  return (
    <article className="page page--kalender">
      <header className="page-head">
        <Wordmark />
        <h1 className="page-head__title">{day.heading}</h1>
        <p className="page-head__lede">
          {day.roomTitle
            ? `Vad som hände med minnet i ${day.roomTitle} den här dagen.`
            : 'Vad Photographic gjorde med det du berättade.'}
        </p>
      </header>

      <nav className="day-nav" aria-label="Byt dag">
        {day.previousDate ? (
          <Link className="btn" to={link(day.previousDate)} rel="prev">
            ← Föregående dag
          </Link>
        ) : (
          <span className="meta">Inget tidigare</span>
        )}
        {day.nextDate ? (
          <Link className="btn" to={link(day.nextDate)} rel="next">
            Nästa dag →
          </Link>
        ) : (
          <span className="meta">Inget senare</span>
        )}
      </nav>

      {/*
        Other people's contributions, first and named.

        Nothing holds incoming material back for a room's owner to approve, so the only
        thing standing between a room and a contribution nobody noticed is a day that
        says so plainly. The same events appear again below in time order; this is the
        part that has to be impossible to scroll past.
      */}
      {others.length > 0 && (
        <section className="section-block" aria-labelledby="fran-andra">
          <h2 className="section-block__title" id="fran-andra">
            Från andra i dina rum
          </h2>
          <ul className="day day--others">
            {others.map((event) => (
              <EventRow key={`other-${event.seq}`} event={event} />
            ))}
          </ul>
        </section>
      )}

      <section className="section-block" aria-labelledby="dagen">
        <h2 className="section-block__title" id="dagen">
          Hela dagen
        </h2>

        {day.events.length === 0 ? (
          <p className="section-block__empty">Inget hände i minnet den här dagen.</p>
        ) : (
          <ul className="day">
            {day.events.map((event) => (
              <EventRow key={event.seq} event={event} />
            ))}
          </ul>
        )}
      </section>

      <p className="page-foot">
        <Link to="/" className="page-foot__link">
          Tillbaka till ditt rum
        </Link>
      </p>
    </article>
  );
}

/**
 * One memory event.
 *
 * The glyph and the label come straight from the scope's own table. Every row carries its
 * motivation, because an automatic action the person cannot read the reason for is the
 * black box this screen exists to open.
 */
function EventRow({ event }: { event: DayEvent }) {
  return (
    <li className={event.byOtherMember ? 'day__row day__row--other' : 'day__row'}>
      <span className="day__glyph" aria-hidden="true">
        {EVENT_GLYPH[event.kind]}
      </span>

      <div className="day__body">
        <p className="day__head">
          <span className="meta day__time">{event.time}</span>
          <span className="day__kind">{EVENT_LABEL[event.kind]}</span>
          <span className="meta">
            {event.who}
            {event.fromRoomTitle
              ? ` · ${event.fromRoomTitle} → ${event.roomTitle}`
              : ` · ${event.roomTitle}`}
          </span>
        </p>

        {event.redacted ? (
          <p className="day__text day__text--gone">Texten är permanent raderad.</p>
        ) : (
          <p className="day__text">{event.body}</p>
        )}

        {/*
          The correction and what it corrected, on the same line of sight. The current
          memory says 1 november; this is how we got there from 15 oktober.
        */}
        {event.previousBody && (
          <p className="day__previous">
            <span className="meta">Tidigare:</span> {event.previousBody}
          </p>
        )}

        {event.disputes.length > 0 && (
          <ul className="day__dispute">
            {event.disputes.map((side, index) => (
              <li key={side.shortId ?? index}>
                <span className="meta">{side.authorName ?? 'Någon'} skrev:</span> {side.body}
              </li>
            ))}
          </ul>
        )}

        {event.sharedWith.length > 0 && (
          <p className="meta">Kan läsas av {event.sharedWith.join(', ')}</p>
        )}

        {event.motivation && <p className="day__why">{event.motivation}</p>}

        <p className="day__foot">
          {event.shortId && <span className="mono">{event.shortId}</span>}
          {event.changed && <span className="meta">ändrat senare</span>}
          <Link className="day__zoom" to={`/kalender/handelse/${event.seq}`}>
            Hur vet du det?
          </Link>
        </p>
      </div>
    </li>
  );
}
