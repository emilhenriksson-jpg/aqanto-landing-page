import { NavLink, Outlet } from 'react-router-dom';

const NAV = [
  { to: '/', end: true, label: 'Rum', icon: HomeIcon },
  { to: '/rum', end: true, label: 'Alla', icon: GridIcon },
  { to: '/klienter', end: true, label: 'Klienter', icon: ClientsIcon },
  { to: '/godkann', end: true, label: 'Godkänn', icon: CheckIcon },
] as const;

/**
 * Desktop: 64px icon-only left rail. Mobile: bottom tab bar.
 * The person is inside a room; the rail is how they walk between spaces.
 */
export function Shell() {
  return (
    <div className="shell">
      <nav className="rail" aria-label="Huvudmeny">
        {NAV.map(({ to, end, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) => (isActive ? 'rail__link rail__link--active' : 'rail__link')}
            aria-label={label}
          >
            <Icon />
            <span className="rail__label">{label}</span>
          </NavLink>
        ))}
      </nav>
      <div className="shell__main">
        <Outlet />
      </div>
    </div>
  );
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

function ClientsIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="8" cy="9" r="2.5" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="16" cy="9" r="2.5" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="12" cy="15.5" r="2.5" stroke="currentColor" strokeWidth="1.6" />
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
