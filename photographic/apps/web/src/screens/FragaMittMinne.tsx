import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';

import { isDemoMode, listRooms } from '../api/index.js';
import { Wordmark } from '../components/Wordmark.js';
import { searchDemoMemory, type AskResultLine } from '../data/demo.js';
import { calmErrorMessage, searchMemoryFromApi } from '../data/load.js';

type Status = 'idle' | 'loading' | 'ready' | 'error';
type QuickRange = 'today' | 'yesterday' | 'week' | 'year';

const QUICK_RANGES: Array<{ id: QuickRange; label: string }> = [
  { id: 'today', label: 'Idag' },
  { id: 'yesterday', label: 'Igår' },
  { id: 'week', label: 'Den här veckan' },
  { id: 'year', label: 'I år' },
];

/**
 * "Fråga mitt minne" (scope §7): one box, searching private memory, every room the
 * person can reach, and the calendar at once. Every result is a card that links back
 * to the room it came from — a search result nobody can trace is the black box this
 * product exists to not be.
 *
 * Demo mirrors live exactly in shape: `searchDemoMemory` scans the same rooms and
 * memories every other demo screen shows, so a demo search never "finds" something the
 * room screens do not also have.
 */
export function FragaMittMinne() {
  const [query, setQuery] = useState('');
  const [activeRange, setActiveRange] = useState<QuickRange | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [results, setResults] = useState<AskResultLine[]>([]);
  const [errorMessage, setErrorMessage] = useState('');
  const [personalRoomId, setPersonalRoomId] = useState<string | null>(null);

  useEffect(() => {
    if (isDemoMode()) return;
    let cancelled = false;
    void listRooms()
      .then(({ rooms }) => {
        if (cancelled) return;
        const personal = rooms.find((room) => room.kind === 'personal');
        if (personal) setPersonalRoomId(personal.roomId);
      })
      .catch(() => {
        // The rail and every other screen already surface a connection problem;
        // this only weakens a link target, not the search itself.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function runSearch(nextQuery: string, range: QuickRange | null) {
    const trimmed = nextQuery.trim();
    if (!trimmed && !range) {
      setStatus('idle');
      setResults([]);
      return;
    }

    if (isDemoMode()) {
      setResults(trimmed ? searchDemoMemory(trimmed) : []);
      setStatus('ready');
      return;
    }

    setStatus('loading');
    try {
      const hits = await searchMemoryFromApi({
        ...(trimmed ? { query: trimmed } : {}),
        ...(range ? rangeFor(range) : {}),
      });
      setResults(hits);
      setStatus('ready');
    } catch (error) {
      setErrorMessage(calmErrorMessage(error));
      setStatus('error');
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void runSearch(query, activeRange);
  }

  function onQuickRange(range: QuickRange) {
    const next = activeRange === range ? null : range;
    setActiveRange(next);
    void runSearch(query, next);
  }

  return (
    <article className="page page--fraga">
      <header className="page-head">
        <Wordmark />
        <h1 className="page-head__title">Fråga mitt minne</h1>
        <p className="page-head__lede">
          Sök i ditt privata minne, dina rum och kalendern på en gång. Varje träff
          länkar tillbaka till rummet den kom från.
        </p>
      </header>

      <form className="ask-form" onSubmit={onSubmit}>
        <input
          className="ask-form__input"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Vad bestämde vi om förvärvet?"
          aria-label="Fråga mitt minne"
        />
        <button type="submit" className="btn btn--brand ask-form__submit">
          Sök
        </button>
      </form>

      <div className="ask-chips" role="group" aria-label="Tidsperiod">
        {QUICK_RANGES.map((range) => (
          <button
            key={range.id}
            type="button"
            className={activeRange === range.id ? 'pill pill--brand ask-chip' : 'pill ask-chip'}
            aria-pressed={activeRange === range.id}
            onClick={() => onQuickRange(range.id)}
          >
            {range.label}
          </button>
        ))}
      </div>

      <AskResults
        status={status}
        results={results}
        errorMessage={errorMessage}
        personalRoomId={personalRoomId}
      />

      <p className="page-foot">
        <Link to="/" className="page-foot__link">
          Tillbaka till ditt rum
        </Link>
      </p>
    </article>
  );
}

function AskResults({
  status,
  results,
  errorMessage,
  personalRoomId,
}: {
  status: Status;
  results: AskResultLine[];
  errorMessage: string;
  personalRoomId: string | null;
}) {
  if (status === 'idle') {
    return <p className="section-block__empty">Ställ en fråga, eller välj en tidsperiod ovan.</p>;
  }
  if (status === 'loading') {
    return <p className="section-block__empty">Söker…</p>;
  }
  if (status === 'error') {
    return <p className="section-block__empty">{errorMessage}</p>;
  }
  if (results.length === 0) {
    return <p className="section-block__empty">Inga träffar. Prova en annan fråga eller tidsperiod.</p>;
  }

  return (
    <ul className="ask-results">
      {results.map((hit) => (
        <li key={`${hit.kind}-${hit.id}`} className="ask-card card">
          <Link to={roomHref(hit.roomId, personalRoomId)} className="ask-card__link">
            <span className="ask-card__room meta">{hit.roomTitle}</span>
            <p className="ask-card__text">{hit.text}</p>
            <span className="chip mono ask-card__meta">{hit.meta}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function roomHref(roomId: string, personalRoomId: string | null): string {
  if (roomId === 'personal' || roomId === personalRoomId) return '/';
  return `/rum/${roomId}`;
}

function rangeFor(range: QuickRange): { since: string; until?: string } {
  const now = new Date();
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

  switch (range) {
    case 'today':
      return { since: startOfDay(now).toISOString() };
    case 'yesterday': {
      const yesterday = new Date(now);
      yesterday.setDate(now.getDate() - 1);
      return { since: startOfDay(yesterday).toISOString(), until: startOfDay(now).toISOString() };
    }
    case 'week': {
      // Monday-start week, matching the calendar's own convention.
      const isoDay = (now.getDay() + 6) % 7;
      const monday = new Date(now);
      monday.setDate(now.getDate() - isoDay);
      return { since: startOfDay(monday).toISOString() };
    }
    case 'year':
      return { since: new Date(now.getFullYear(), 0, 1).toISOString() };
  }
}
