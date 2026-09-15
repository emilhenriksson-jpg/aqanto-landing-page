import type { ReactNode } from 'react';

import { DEMO_DOCUMENTS, type DocumentLine } from '../data/demo.js';
import { loadDocumentsFromApi } from '../data/load.js';
import { useRoomData } from '../hooks/useRoomData.js';

type DocumentsSectionProps = {
  /** When set, render these rows and skip the loader. */
  documents?: DocumentLine[];
  /** Load demo / live documents for this room when `documents` is omitted. */
  roomId?: string;
};

/** Calm Dokument shelf inside a room — soft rows, never a file grid. */
export function DocumentsSection({ documents, roomId }: DocumentsSectionProps) {
  if (documents !== undefined) {
    return <DocumentsShelf documents={documents} />;
  }

  if (!roomId) {
    return <DocumentsShelf documents={[]} />;
  }

  return <DocumentsSectionLoader roomId={roomId} />;
}

function DocumentsSectionLoader({ roomId }: { roomId: string }) {
  const state = useRoomData(
    `documents:${roomId}`,
    () => DEMO_DOCUMENTS[roomId] ?? [],
    () => loadDocumentsFromApi(roomId),
  );

  if (state.status === 'loading') {
    return <DocumentsShelfFrame empty="Hämtar dokument…" />;
  }
  if (state.status === 'error') {
    return <DocumentsShelfFrame empty={state.message} />;
  }

  return <DocumentsShelf documents={state.data} />;
}

function DocumentsShelf({ documents }: { documents: DocumentLine[] }) {
  const rows = Array.isArray(documents) ? documents : [];
  if (rows.length === 0) {
    return <DocumentsShelfFrame empty="Inga dokument ännu." />;
  }

  return (
    <DocumentsShelfFrame>
      <ul className="documents">
        {rows.map((doc) => (
          <li key={doc.id} className="documents__row">
            <span className="documents__title">{doc.title}</span>
            {doc.meta ? <span className="meta">{doc.meta}</span> : null}
          </li>
        ))}
      </ul>
    </DocumentsShelfFrame>
  );
}

function DocumentsShelfFrame({
  children,
  empty,
}: {
  children?: ReactNode;
  empty?: string;
}) {
  return (
    <section className="section-block" aria-labelledby="room-documents">
      <h2 id="room-documents" className="section-block__title">
        Dokument
      </h2>
      {empty ? <p className="section-block__empty">{empty}</p> : children}
    </section>
  );
}
