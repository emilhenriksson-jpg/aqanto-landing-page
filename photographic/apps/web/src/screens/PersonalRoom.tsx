import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { forgetMemory, isDemoMode, undoMemory } from '../api/index.js';
import { CalmState, LoadingState } from '../components/CalmState.js';
import { DocumentsSection } from '../components/DocumentsSection.js';
import { MemoryRow } from '../components/MemoryRow.js';
import { TokenMeter } from '../components/TokenMeter.js';
import { Wordmark } from '../components/Wordmark.js';
import {
  PERSONAL_SECTION_ORDER,
  SECTION_LABELS,
  loadRoom,
  type MemoryLine,
  type RoomDetail,
} from '../data/demo.js';
import { loadPersonalRoomFromApi } from '../data/load.js';
import { useRoomData } from '../hooks/useRoomData.js';

/**
 * The most important screen: standing inside the personal room.
 * First viewport is one composition — hero-level brand above, identity + meter
 * at the floor — then profile sections as quiet card groups below.
 */
export function PersonalRoom() {
  const state = useRoomData(
    'personal',
    () => {
      const loaded = loadRoom('personal');
      if (!loaded) throw new Error('Missing personal room in demo data');
      return loaded;
    },
    () => loadPersonalRoomFromApi(),
  );

  if (state.status === 'loading') return <LoadingState label="Hämtar ditt rum…" />;
  if (state.status === 'error') {
    return <CalmState title="Ditt rum" message={state.message} />;
  }

  return <PersonalRoomReady room={state.data} />;
}

function PersonalRoomReady({ room }: { room: RoomDetail }) {
  const ceiling = room.tokenCeiling;
  const [tokenCount, setTokenCount] = useState(room.tokenCount);
  /** Undo tokens from soft-delete; keyed by shortId for the same-turn Ångra. */
  const undoTokens = useRef(new Map<string, string>());
  /** In-flight forget promises so a fast Ångra can wait for the undo token. */
  const forgetInFlight = useRef(new Map<string, Promise<string | null>>());

  const sections = useMemo(() => {
    return PERSONAL_SECTION_ORDER.map((kind) => ({
      kind,
      title: SECTION_LABELS[kind],
      items: room.memories.filter((item) => item.kind === kind),
    })).filter((section) => section.items.length > 0 || kindIsCore(section.kind));
  }, [room.memories]);

  async function forget(shortId: string) {
    setTokenCount((n) => Math.max(0, n - 24));
    if (isDemoMode()) return;

    const pending = (async (): Promise<string | null> => {
      try {
        const result = await forgetMemory(shortId, room.id);
        undoTokens.current.set(shortId, result.undoToken);
        return result.undoToken;
      } catch {
        // Soft-delete is best-effort from the row; the UI already shows "Borttaget".
        return null;
      } finally {
        forgetInFlight.current.delete(shortId);
      }
    })();

    forgetInFlight.current.set(shortId, pending);
    await pending;
  }

  async function restore(shortId: string) {
    setTokenCount((n) => Math.min(ceiling, n + 24));
    if (isDemoMode()) return;

    let token = undoTokens.current.get(shortId);
    if (!token) {
      const pending = forgetInFlight.current.get(shortId);
      if (pending) token = (await pending) ?? undefined;
    }
    if (!token) return;

    try {
      await undoMemory(token);
      undoTokens.current.delete(shortId);
    } catch {
      // Same: keep the row restored locally if the network call fails.
    }
  }

  return (
    <article className="page page--personal">
      <header className="hero hero--personal">
        <Wordmark large />
        <div className="hero__identity">
          <h1 className="hero__title">{room.title}</h1>
          <p className="hero__lede">
            Det här är ditt minne, läst av vilken modell du än pratar med. Varje rad har ett
            kort id så du kan peka på den.
          </p>
          <TokenMeter used={tokenCount} ceiling={room.tokenCeiling} />
        </div>
      </header>

      <div className="sections">
        {sections.map((section) => (
          <section
            key={section.kind}
            className="section-block"
            aria-labelledby={`sec-${section.kind}`}
          >
            <h2 id={`sec-${section.kind}`} className="section-block__title">
              {section.title}
            </h2>
            {section.items.length === 0 ? (
              <p className="section-block__empty">Inget sparat här ännu.</p>
            ) : (
              <ul className="card card--group">
                {section.items.map((item: MemoryLine) => (
                  <MemoryRow
                    key={item.shortId}
                    item={item}
                    onForget={forget}
                    onRestore={restore}
                  />
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>

      <DocumentsSection roomId={room.id} />

      <footer className="page-foot">
        <Link to="/papperskorg" className="page-foot__link">
          Papperskorg
        </Link>
      </footer>
    </article>
  );
}

function kindIsCore(kind: MemoryLine['kind']): boolean {
  return (
    kind === 'identity' ||
    kind === 'fact' ||
    kind === 'preference' ||
    kind === 'instruction' ||
    kind === 'never'
  );
}
