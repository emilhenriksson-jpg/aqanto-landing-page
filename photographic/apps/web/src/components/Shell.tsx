import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';

import { usePendingApprovals } from '../hooks/usePendingApprovals.js';
import { Wordmark } from './Wordmark.js';

const PRIMARY = [
  { to: '/chatt', end: true, label: 'Start', icon: HomeIcon },
  { to: '/rum', end: false, label: 'Rum', icon: GridIcon },
  { to: '/kalender', end: false, label: 'Kalender', icon: CalendarIcon },
  { to: '/godkann', end: true, label: 'Godkänn', icon: CheckIcon },
] as const;
const SECONDARY = [
  { to: '/fraga', end: true, label: 'Fråga', icon: AskIcon },
  { to: '/klienter', end: true, label: 'Dina AI:er', icon: ClientsIcon },
  { to: '/konto', end: false, label: 'Konto', icon: AccountIcon },
] as const;

/** A labelled sidebar on desktop; four stable destinations and More on mobile. */
export function Shell() {
  const { pathname } = useLocation();
  const pending = usePendingApprovals();
  const waiting = pending?.length ?? 0;
  const [moreOpen, setMoreOpen] = useState(false);
  const navRef = useRef<HTMLElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const moreActive = SECONDARY.some(({ to, end }) => pathname === to || (!end && pathname.startsWith(`${to}/`)));

  useEffect(() => {
    if (!moreOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !navRef.current?.contains(event.target)) setMoreOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setMoreOpen(false); moreRef.current?.focus(); }
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', escape);
    };
  }, [moreOpen]);

  function navLink({ to, end, label, icon: Icon }: (typeof PRIMARY)[number] | (typeof SECONDARY)[number]) {
    const badge = to === '/godkann' ? waiting : 0;
    return <NavLink key={to} to={to} end={end} onClick={() => setMoreOpen(false)}
      className={({ isActive }) => isActive || (to === '/rum' && pathname === '/personligt') ? 'rail__link rail__link--active' : 'rail__link'}
      aria-label={badge > 0 ? `${label}, ${waitingLabel(badge)}` : label}>
      <Icon />
      <span className="rail__label">{label}</span>
      {badge > 0 && <span className="rail__badge" aria-hidden="true">{badge > 9 ? '9+' : badge}</span>}
    </NavLink>;
  }

  return <div className="shell">
    <a className="skip-link" href="#main-content">Till innehållet</a>
    <nav className="rail" aria-label="Huvudmeny" ref={navRef}>
      <Link className="rail__brand" to="/chatt" aria-label="Photographic startsida"><Wordmark /></Link>
      <div className="rail__primary">{PRIMARY.map(navLink)}</div>
      <button className={`rail__more${moreOpen || moreActive ? ' rail__more--open' : ''}`} ref={moreRef}
        aria-current={moreActive ? 'page' : undefined}
        aria-expanded={moreOpen} aria-controls="more-navigation" onClick={() => setMoreOpen(open => !open)}>
        <MoreIcon /><span>Mer</span>
      </button>
      <div className={`rail__secondary${moreOpen ? ' rail__secondary--open' : ''}`} id="more-navigation">
        <span className="rail__section-label">Ditt Photographic</span>
        {SECONDARY.map(navLink)}
      </div>
      <p className="rail__foot">Ditt minne. Ditt sammanhang.</p>
    </nav>
    <main className="shell__main" id="main-content" tabIndex={-1}>
      <div className="shell__mobile-brand"><Wordmark /></div>
      <Outlet />
    </main>
  </div>;
}

function MoreIcon() {
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" />
  </svg>;
}

/** "1 väntar på dig" / "3 väntar på dig" — read out, never just a number. */
export function waitingLabel(count: number): string {
  return count === 1 ? '1 väntar på dig' : `${count} väntar på dig`;
}

function HomeIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-5v-6H10v6H5a1 1 0 0 1-1-1v-9.5Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function GridIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="4" y="4" width="7" height="7" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <rect x="13" y="4" width="7" height="7" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <rect x="4" y="13" width="7" height="7" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <rect x="13" y="13" width="7" height="7" rx="2" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="4" y="5.5" width="16" height="14.5" rx="3" stroke="currentColor" strokeWidth="1.6" />
      <path d="M4 10.5h16" stroke="currentColor" strokeWidth="1.6" />
      <path d="M8.5 3.5v4M15.5 3.5v4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function AskIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M20 20 15.8 15.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function ClientsIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="8" cy="9" r="2.5" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="16" cy="9" r="2.5" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="12" cy="15.5" r="2.5" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

function AccountIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="8.5" r="3.5" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M5 20c1.2-3.4 3.7-5 7-5s5.8 1.6 7 5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M5 12.5 10 17.5 19 7"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
