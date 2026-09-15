import { DEMO_DOCUMENTS, type DocumentLine } from '../data/demo.js';
import { loadDocumentsFromApi } from '../data/load.js';
import { useRoomData } from '../hooks/useRoomData.js';

/** Calm Dokument shelf inside a room — soft rows, never a file grid. */
export function DocumentsSection({ roomId }: { roomId: string }) {
  const state = useRoomData(
    `documents:${roomId}`,
    () => DEMO_DOCUMENTS[roomId] ?? [],
    () => loadDocumentsFromApi(roomId),
  );

  return (
    <section className="section-block" aria-labelledby="room-documents">
      <h2 id="room-documents" className="section-block__title">
        Dokument
      </h2>
      {state.status === 'loading' ? (
        <p className="section-block__empty">Hämtar dokument…</p>
      ) : state.status === 'error' ? (
        <p className="section-block__empty">{state.message}</p>
      ) : (
        <DocumentList documents={state.data} />
      )}
    </section>
  );
}

function DocumentList({ documents }: { documents: DocumentLine[] }) {
  if (documents.length === 0) {
    return <p className="section-block__empty">Inga dokument ännu.</p>;
  }

  return (
    <ul className="documents">
      {documents.map((doc) => (
        <li key={doc.id} className="documents__row">
          <span className="documents__title">{doc.title}</span>
          {doc.meta ? <span className="meta">{doc.meta}</span> : null}
        </li>
      ))}
    </ul>
  );
}
