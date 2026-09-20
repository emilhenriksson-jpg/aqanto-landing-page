import { useEffect, useRef, useState } from 'react';
import type { ClientId, VerificationHandle, VerificationState } from '@photographic/connect';
import { apiFetch } from '../api/client.js';
import { isDemoMode } from '../api/config.js';

type CheckState = 'idle' | 'waiting' | 'connected' | 'timed_out' | 'error' | 'demo';

/** A click starts observation; neither opening an app nor copying a URL is success. */
export function useConnectionCheck(clientId: ClientId) {
  const [state, setState] = useState<CheckState>('idle');
  const [hasReceipt, setHasReceipt] = useState(false);
  const [attempt, setAttempt] = useState<{ purpose: 'setup' | 'chat'; sequence: number } | null>(null);
  const running = useRef(false);
  const savedHandle = useRef<VerificationHandle | null>(null);

  function start(purpose: 'setup' | 'chat', resume = false) {
    if (running.current) return;
    if (isDemoMode()) { setState('demo'); return; }
    if (!resume) savedHandle.current = null;
    running.current = true;
    setState('waiting');
    setAttempt(previous => ({ purpose, sequence: (previous?.sequence ?? 0) + 1 }));
  }

  useEffect(() => {
    if (!attempt) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let inFlight = false;
    let finished = false;
    running.current = true;
    const fail = () => {
      if (!controller.signal.aborted) {
        finished = true;
        running.current = false;
        setState('error');
      }
    };

    async function poll() {
      if (inFlight || finished || controller.signal.aborted || !savedHandle.current) return;
      clearTimeout(timer);
      inFlight = true;
      try {
        const result = await apiFetch<VerificationState>('/v1/connect/status', {
          method: 'POST', body: JSON.stringify({ handle: savedHandle.current }), signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (result.status === 'waiting') {
          timer = setTimeout(() => { poll().catch(fail); }, 2500);
        } else {
          finished = true;
          running.current = false;
          setState(result.status);
          if (result.status === 'connected') setHasReceipt(true);
        }
      } catch {
        if (!controller.signal.aborted) {
          finished = true;
          running.current = false;
          setState('error');
        }
      } finally { inFlight = false; }
    }

    async function begin() {
      try {
        if (!savedHandle.current) {
          const result = await apiFetch<{ handle: VerificationHandle }>('/v1/connect/verify', {
            method: 'POST', body: JSON.stringify({ clientId, purpose: attempt!.purpose }), signal: controller.signal,
          });
          if (controller.signal.aborted) return;
          savedHandle.current = result.handle;
        }
        await poll();
      } catch {
        if (!controller.signal.aborted) { running.current = false; setState('error'); }
      }
    }

    // Browsers throttle background timers. Check immediately when the person returns.
    const onReturn = () => { if (document.visibilityState !== 'hidden') poll().catch(fail); };
    window.addEventListener('focus', onReturn);
    document.addEventListener('visibilitychange', onReturn);
    begin().catch(fail);
    return () => {
      controller.abort();
      clearTimeout(timer);
      running.current = false;
      window.removeEventListener('focus', onReturn);
      document.removeEventListener('visibilitychange', onReturn);
    };
  }, [attempt, clientId]);

  return { state, hasReceipt, start, retry: () => start(attempt?.purpose ?? 'setup', state === 'error') };
}
