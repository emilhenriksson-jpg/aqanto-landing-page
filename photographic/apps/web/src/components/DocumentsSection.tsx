import { useRef, useState, type ReactNode } from 'react';

import { isDemoMode } from '../api/config.js';
import { uploadRoomDocument } from '../api/index.js';
import { DEMO_DOCUMENTS, type DocumentLine } from '../data/demo.js';
import { calmErrorMessage, loadDocumentsFromApi } from '../data/load.js';
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
  // Bumped after an upload so the shelf reloads, rather than the new row being pushed
  // in locally. What a document *is* — searchable or not, how many pages — is decided
  // by extraction on the server, and guessing it here would show a row that says
  // something different from the truth for as long as the screen stays open.
  const [reloadKey, setReloadKey] = useState(0);

  /**
   * The upload result lives here, above the shelf.
   *
   * It used to live inside the upload control, which sits below the loading/ready
   * branch — so the reload that follows a successful upload remounted the control and
   * the confirmation disappeared in the same frame it appeared. That is worst in the
   * case most worth reading: "sparad, men vi kunde inte läsa ut text ur den" is how a
   * person finds out a scanned PDF will not be searchable.
   */
  const [result, setResult] = useState<string | null>(null);

  const state = useRoomData(
    `documents:${roomId}:${reloadKey}`,
    () => DEMO_DOCUMENTS[roomId] ?? [],
    () => loadDocumentsFromApi(roomId),
  );

  const uploader = (
    <DocumentUpload
      roomId={roomId}
      message={result}
      onResult={setResult}
      onUploaded={() => setReloadKey((n) => n + 1)}
    />
  );

  if (state.status === 'loading') {
    return <DocumentsShelfFrame empty="Hämtar dokument…" footer={uploader} />;
  }
  if (state.status === 'error') {
    return <DocumentsShelfFrame empty={state.message} footer={uploader} />;
  }

  return <DocumentsShelf documents={state.data} footer={uploader} />;
}

/**
 * Upload into this room.
 *
 * A file input behind a quiet button rather than a drop zone. A drop zone on a page that
 * is mostly text invites dropping a file onto a memory line, and the affordance has to
 * be unmistakable about *which room* the file lands in — that is the whole decision
 * being made here.
 */
function DocumentUpload({
  roomId,
  message,
  onResult,
  onUploaded,
}: {
  roomId: string;
  message: string | null;
  onResult: (message: string | null) => void;
  onUploaded: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  if (isDemoMode()) return null;

  const send = async (file: File) => {
    setBusy(true);
    onResult(null);

    try {
      const result = await uploadRoomDocument(roomId, file);

      // Three outcomes worth telling apart. A stored and searchable file, a stored file
      // we could not read — which is a normal thing to be handed and not a failure —
      // and an actual refusal.
      onResult(
        result.document.searchable
          ? `"${result.document.filename}" är sparad och sökbar.`
          : `"${result.document.filename}" är sparad, men vi kunde inte läsa ut text ur den.`,
      );
      onUploaded();
    } catch (error) {
      onResult(calmErrorMessage(error));
    } finally {
      setBusy(false);
      // Cleared so choosing the same file again re-fires `change`, which it otherwise
      // does not — and a retry that silently does nothing is worse than an error.
      if (input.current) input.current.value = '';
    }
  };

  return (
    <div className="documents__upload">
      <input
        ref={input}
        type="file"
        className="documents__input"
        aria-label="Välj en fil att lägga i rummet"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void send(file);
        }}
      />
      <button
        type="button"
        className="btn btn--quiet"
        disabled={busy}
        onClick={() => input.current?.click()}
      >
        {busy ? 'Laddar upp…' : 'Lägg till dokument'}
      </button>
      {message ? (
        <p className="documents__status meta" role="status">
          {message}
        </p>
      ) : null}
    </div>
  );
}

function DocumentsShelf({
  documents,
  footer,
}: {
  documents: DocumentLine[];
  footer?: ReactNode;
}) {
  const rows = Array.isArray(documents) ? documents : [];
  if (rows.length === 0) {
    return <DocumentsShelfFrame empty="Inga dokument ännu." footer={footer} />;
  }

  return (
    <DocumentsShelfFrame footer={footer}>
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
  footer,
}: {
  children?: ReactNode;
  empty?: string;
  footer?: ReactNode;
}) {
  return (
    <section className="section-block" aria-labelledby="room-documents">
      <h2 id="room-documents" className="section-block__title">
        Dokument
      </h2>
      {empty ? <p className="section-block__empty">{empty}</p> : children}
      {footer}
    </section>
  );
}
