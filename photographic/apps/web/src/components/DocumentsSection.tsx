import { DEMO_DOCUMENTS, type DocumentLine } from '../data/demo.js';

/** Calm Dokument shelf inside a room — soft rows, never a file grid. */
export function DocumentsSection({ roomId }: { roomId: string }) {
  const documents: DocumentLine[] = DEMO_DOCUMENTS[roomId] ?? [];

  return (
    <section className="section-block" aria-labelledby="room-documents">
      <h2 id="room-documents" className="section-block__title">
        Dokument
      </h2>
      {documents.length === 0 ? (
        <p className="section-block__empty">Inga dokument ännu.</p>
      ) : (
        <ul className="documents">
          {documents.map((doc) => (
            <li key={doc.id} className="documents__row">
              <span className="documents__title">{doc.title}</span>
              <span className="meta">{doc.meta}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
