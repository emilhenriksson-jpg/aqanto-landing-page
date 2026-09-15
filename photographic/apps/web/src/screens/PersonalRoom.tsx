import { useMemo, useState } from 'react';

import { MemoryRow } from '../components/MemoryRow.js';
import { TokenMeter } from '../components/TokenMeter.js';
import { Wordmark } from '../components/Wordmark.js';
import {
  PERSONAL_SECTION_ORDER,
  SECTION_LABELS,
  loadRoom,
  type MemoryLine,
} from '../data/demo.js';

/**
 * The most important screen: standing inside the personal room.
 * First viewport is one composition — brand, title, lede, token meter —
 * then profile sections as card groups below.
 */
export function PersonalRoom() {
  const loaded = loadRoom('personal');
  if (!loaded) throw new Error('Missing personal room in demo data');
  const room = loaded;
  const ceiling = room.tokenCeiling;

  const [tokenCount, setTokenCount] = useState(room.tokenCount);

  const sections = useMemo(() => {
    return PERSONAL_SECTION_ORDER.map((kind) => ({
      kind,
      title: SECTION_LABELS[kind],
      items: room.memories.filter((item) => item.kind === kind),
    })).filter((section) => section.items.length > 0 || kindIsCore(section.kind));
  }, [room.memories]);

  function forget(_shortId: string) {
    setTokenCount((n) => Math.max(0, n - 24));
  }

  function restore(_shortId: string) {
    setTokenCount((n) => Math.min(ceiling, n + 24));
  }

  return (
    <article className="page page--personal">
      <header className="hero hero--personal">
        <Wordmark large />
        <h1 className="hero__title">{room.title}</h1>
        <p className="hero__lede">
          Det här är ditt minne, läst av vilken modell du än pratar med. Varje rad har ett
          kort id så du kan peka på den.
        </p>
        <TokenMeter used={tokenCount} ceiling={room.tokenCeiling} />
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
