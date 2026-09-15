import { useEffect, useState } from 'react';

import { isDemoMode } from '../api/config.js';
import { calmErrorMessage } from '../data/load.js';

export type LoadState<T> =
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'error'; message: string };

/**
 * Demo mode resolves synchronously so existing tests stay free of `waitFor`.
 * Live mode fetches once per `key` and never throws into the render tree.
 */
export function useRoomData<T>(
  key: string,
  demo: () => T,
  live: () => Promise<T>,
): LoadState<T> {
  const [state, setState] = useState<LoadState<T>>(() => {
    if (isDemoMode()) {
      try {
        return { status: 'ready', data: demo() };
      } catch (error) {
        return { status: 'error', message: calmErrorMessage(error) };
      }
    }
    return { status: 'loading' };
  });

  useEffect(() => {
    if (isDemoMode()) {
      try {
        setState({ status: 'ready', data: demo() });
      } catch (error) {
        setState({ status: 'error', message: calmErrorMessage(error) });
      }
      return;
    }

    let cancelled = false;
    setState({ status: 'loading' });

    void live()
      .then((data) => {
        if (!cancelled) setState({ status: 'ready', data });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ status: 'error', message: calmErrorMessage(error) });
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key is the intentional dependency
  }, [key]);

  return state;
}
