import { Link } from 'react-router-dom';

import { CalmState, LoadingState } from '../components/CalmState.js';
import { Wordmark } from '../components/Wordmark.js';
import { DEMO_COMPASS, type CompassLine } from '../data/demo.js';
import { loadCompassFromApi } from '../data/load.js';
import { useRoomData } from '../hooks/useRoomData.js';

/**
 * Read-only by design for V1 — see docs/agent-instruction-layer.md for the reasoning.
 * The six principles change through conversation (any connected model can propose a
 * change, which lands in Godkänn), not through a form here. This screen exists so it is
 * possible to see, in one place, what is currently governing every model's stance
 * toward the person — a default's wording, or their own, and when.
 *
 * Live: GET /v1/profile behind VITE_USE_DEMO=0, `compass` field.
 */
export function Kompass() {
  const state = useRoomData(
    'kompass',
    () => DEMO_COMPASS,
    () => loadCompassFromApi(),
  );

  if (state.status === 'loading') return <LoadingState label="Hämtar kompassen…" />;
  if (state.status === 'error') {
    return <CalmState title="Personlig kompass" message={state.message} />;
  }

  return <KompassReady principles={state.data} />;
}

function KompassReady({ principles }: { principles: CompassLine[] }) {
  return (
    <article className="page page--kompass">
      <header className="page-head">
        <Wordmark />
        <h1 className="page-head__title">Personlig kompass</h1>
        <p className="page-head__lede">
          Sex principer för hur varje ansluten modell bemöter dig, alltid — inte bara när du
          påminner den. Ändras genom att berätta det för en modell, som frågar dig innan
          något sparas; det syns här när det är gjort.
        </p>
      </header>

      <ul className="card card--group compass-list">
        {principles.map((principle) => (
          <li key={principle.key} className="compass-row">
            <p className="compass-row__label meta">{principle.label}</p>
            <p className="compass-row__text">{principle.text}</p>
            <p className="compass-row__meta meta">
              {principle.source === 'personal'
                ? `Din egen formulering${principle.shortId ? ` (${principle.shortId})` : ''}`
                : 'Standard — inget du har ändrat än'}
            </p>
          </li>
        ))}
      </ul>

      <footer className="page-foot">
        <Link to="/personligt" className="page-foot__link">
          Tillbaka till ditt rum
        </Link>
        <Link to="/historik" className="page-foot__link">
          Historik
        </Link>
      </footer>
    </article>
  );
}
