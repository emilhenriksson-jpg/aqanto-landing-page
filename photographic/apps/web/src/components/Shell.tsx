import { NavLink, Outlet } from 'react-router-dom';

import { usePendingApprovals } from '../hooks/usePendingApprovals.js';

const NAV = [
  { to: '/chatt', end: true, label: 'Start', icon: HomeIcon },
  { to: '/rum', end: true, label: 'Alla', icon: GridIcon },
  // The calendar earns a rail slot: the scope calls it a central part of the app, the
  // chronological representation of the person's memory, not something internal to the AI.
  { to: '/kalender', end: false, label: 'Kalender', icon: CalendarIcon },
  { to: '/fraga', end: true, label: 'Fråga', icon: AskIcon },
  { to: '/klienter', end: true, label: 'Klienter', icon: ClientsIcon },
  { to: '/godkann', end: true, label: 'Godkänn', icon: CheckIcon },
  // Export and permanent deletion, which had no caller anywhere in the app. One slot
  // rather than two: the rail is the phone's entire navigation, and seven labels is what
  // fits at 320px without them truncating.
  { to: '/konto', end: false, label: 'Konto', icon: AccountIcon },
] as const;

/**
 * Desktop: 64px icon-only left rail. Mobile: bottom tab bar.
 * The person is inside a room; the rail is how they walk between spaces.
 */
export function Shell() {
  const pending = usePendingApprovals();
  const waiting = pending?.length ?? 0;

  return (
    <div className="shell">
      <nav className="rail" aria-label="Huvudmeny">
        {NAV.map(({ to, end, label, icon: Icon }) => {
          /*
            The only count in the rail, and the only place violet appears here.
            It is on `Godkänn` because that is the one destination where the product is
            waiting for the person rather than the other way round — everything else can
            be visited whenever. No badge at zero: a permanent ornament stops being read.
          */
          const badge = to === '/godkann' && waiting > 0 ? waiting : 0;

          return (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                isActive ? 'rail__link rail__link--active' : 'rail__link'
              }
              aria-label={badge > 0 ? `${label}, ${waitingLabel(badge)}` : label}
            >
              <Icon />
              {badge > 0 ? (
                <span className="rail__badge" aria-hidden="true">
                  {badge > 9 ? '9+' : badge}
                </span>
              ) : null}
              <span className="rail__label">{label}</span>
            </NavLink>
          );
        })}
      </nav>
      <div className="shell__main">
        <Outlet />
      </div>
    </div>
  );
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
