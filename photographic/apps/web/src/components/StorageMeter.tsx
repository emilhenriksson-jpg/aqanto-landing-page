import { useEffect, useState } from 'react';

import { getStorage } from '../api/index.js';
import { isDemoMode } from '../api/config.js';

/**
 * How much of the 10 GB a person is using.
 *
 * A product limit rather than a reserved quota, and the copy says so: "10 GB ingår"
 * rather than "10 GB allocated". Someone using 80 MB costs 80 MB.
 *
 * Deliberately quiet, and hidden entirely below a fifth of the limit. A storage bar on
 * a screen for someone using 0.008% of their space is an anxiety generator about a
 * number that will not matter for years — and this product is asking people to trust it
 * with decades of their life, which is the opposite feeling.
 */

/** Below this, the meter is not shown at all. */
const VISIBILITY_THRESHOLD = 0.2;
/** Above this, it stops being ambient and starts being a warning. */
const WARNING_THRESHOLD = 0.9;

type StorageState =
  | { status: 'hidden' }
  | { status: 'ready'; fraction: number; usedLabel: string; limitLabel: string; remainingLabel: string };

export function StorageMeter() {
  const [state, setState] = useState<StorageState>({ status: 'hidden' });

  useEffect(() => {
    if (isDemoMode()) return;
    let cancelled = false;

    getStorage()
      .then(({ storage }) => {
        if (cancelled) return;
        setState({
          status: 'ready',
          fraction: storage.fraction,
          usedLabel: storage.usedLabel,
          limitLabel: storage.limitLabel,
          remainingLabel: storage.remainingLabel,
        });
      })
      // Silent. A storage figure failing to load is not worth an error on a screen a
      // person opened to read their memories.
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, []);

  if (state.status === 'hidden') return null;
  if (state.fraction < VISIBILITY_THRESHOLD) return null;

  const warning = state.fraction >= WARNING_THRESHOLD;
  const percent = Math.round(state.fraction * 100);

  return (
    <section
      className={`storage${warning ? ' storage--warning' : ''}`}
      aria-labelledby="storage-title"
    >
      <h2 id="storage-title" className="storage__title">
        Lagring
      </h2>
      <div
        className="storage__bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={`${state.usedLabel} av ${state.limitLabel} använt`}
      >
        <span className="storage__fill" style={{ width: `${Math.max(percent, 2)}%` }} />
      </div>
      <p className="storage__meta meta">
        {warning
          ? `${state.remainingLabel} kvar av ${state.limitLabel}. Ta bort något du inte behöver, eller hör av dig om du behöver mer plats.`
          : `${state.usedLabel} av ${state.limitLabel} använt.`}
      </p>
    </section>
  );
}
