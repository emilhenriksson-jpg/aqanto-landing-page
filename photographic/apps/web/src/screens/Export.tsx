import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import {
  createExportLink,
  getExport,
  isDemoMode,
  listExports,
  requestExport,
  type ExportJobDto,
} from '../api/index.js';
import { CalmState, LoadingState } from '../components/CalmState.js';
import { Wordmark } from '../components/Wordmark.js';
import { calmErrorMessage } from '../data/load.js';
import { useRoomData } from '../hooks/useRoomData.js';

/**
 * "Ta med ditt minne" — the export, with a caller at last.
 *
 * The API has been built, tested and first-party gated for a while with nothing able to
 * press it. Two things this screen has to do beyond having a button. It has to say what
 * the archive contains before it is asked for, because the scope is a deliberate decision
 * and not an obvious one: the default archive is the person's own writing, including their
 * contributions to shared rooms, and *not* everyone else's notes from those rooms. And it
 * has to be honest that the request is queued rather than instant, since an export reads a
 * whole life and the wait is a property of the product rather than a hiccup.
 *
 * Live: POST/GET /v1/export, POST /v1/export/:id/link behind VITE_USE_DEMO=0.
 */
export function Export() {
  const state = useRoomData(
    'export',
    (): ExportJobDto[] => [],
    async () => (await listExports()).exports,
  );

  if (state.status === 'loading') return <LoadingState label="Hämtar dina exporter…" />;
  if (state.status === 'error') {
    return <CalmState title="Ta med ditt minne" message={state.message} />;
  }

  return <ExportReady initial={state.data} />;
}

/** How long a minted download link lives, per `DOWNLOAD_TTL_SECONDS` on the server. */
const LINK_DAYS = 7;

function ExportReady({ initial }: { initial: ExportJobDto[] }) {
  const demo = isDemoMode();
  const [jobs, setJobs] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<{ id: string; url: string } | null>(null);

  const building = jobs.find((job) => job.status === 'pending' || job.status === 'running');
  const buildingId = building?.id ?? null;

  /**
   * Poll only while something is being built.
   *
   * The archive is assembled by a background sweep rather than in the request, so the
   * screen has to find out. Ten seconds matches that sweep's cadence; asking faster would
   * be asking a question whose answer cannot have changed.
   */
  const pollRef = useRef<number | null>(null);
  useEffect(() => {
    if (demo || !buildingId) return;

    const tick = async () => {
      try {
        const { export: job } = await getExport(buildingId);
        setJobs((current) => current.map((row) => (row.id === job.id ? job : row)));
      } catch {
        // A failed poll says nothing about the job. The next one asks again.
      }
    };

    pollRef.current = window.setInterval(() => void tick(), 5_000);
    return () => {
      if (pollRef.current !== null) window.clearInterval(pollRef.current);
    };
  }, [demo, buildingId]);

  async function request() {
    setError(null);
    setBusy(true);
    try {
      const { export: job } = await requestExport();
      setJobs((current) => [job, ...current.filter((row) => row.id !== job.id)]);
      setMessage(
        'Exporten är beställd. Den byggs i bakgrunden — du kan lämna sidan och komma tillbaka.',
      );
    } catch (caught) {
      setError(calmErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function download(exportId: string) {
    setError(null);
    setBusy(true);
    try {
      const minted = await createExportLink(exportId);
      setLink({ id: exportId, url: minted.url });
      // The archive arrives as an attachment, so navigating to it starts the download and
      // leaves this screen where it was.
      window.location.assign(minted.url);
    } catch (caught) {
      setError(calmErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="page page--export">
      <header className="page-head">
        <Wordmark />
        <h1 className="page-head__title">Ta med ditt minne</h1>
        <p className="page-head__lede">
          En export är hela din logg plus dina filer, i ett zip-arkiv som går att läsa utan
          Photographic. Loggen och inte bara nuläget: den som öppnar arkivet ska kunna se
          hur något blev som det är, inte bara vad som gäller idag.
        </p>
      </header>

      <section className="section-block" aria-labelledby="sec-innehall">
        <h2 id="sec-innehall" className="section-block__title">
          Det här får du
        </h2>
        <ul className="card export-facts">
          <li>Hela ditt privata rum — varje minne och varje ändring, i den ordning de hände.</li>
          <li>
            Dina egna bidrag i delade rum. Inte de andras anteckningar: ett delat rum är ett
            gemensamt minne, och ett helt rumsutdrag är en egen begäran per rum.
          </li>
          <li>Rummen du är med i: namn, roller och medlemmar, så du vet vem du har delat med.</li>
          <li>Dina uppladdade dokument i original.</li>
          <li>
            En <span className="mono">README.md</span> på svenska och en{' '}
            <span className="mono">manifest.json</span> med sha256 per fil, så arkivet går att
            läsa om tio år.
          </li>
        </ul>
        <p className="meta export-note">
          Varje rum exporten rör får en händelse i loggen. Rummets andra medlemmar kan se att du
          tog en kopia av dina egna bidrag — det är samma öppenhet du själv får om dem.
        </p>
      </section>

      <section className="section-block" aria-labelledby="sec-begar">
        <h2 id="sec-begar" className="section-block__title">
          Begär en export
        </h2>
        {demo ? (
          <p className="section-block__empty">
            Demoläge: ingen riktig export begärs härifrån. Kör mot ett inloggat konto för att
            beställa arkivet.
          </p>
        ) : (
          <>
            <button
              type="button"
              className="btn btn--brand"
              onClick={() => void request()}
              disabled={busy || Boolean(building)}
            >
              {building ? 'Förbereds…' : 'Begär export'}
            </button>
            {message ? <p className="meta export-note">{message}</p> : null}
            {error ? (
              <p className="meta export-note" role="alert">
                {error}
              </p>
            ) : null}
          </>
        )}
      </section>

      <section className="section-block" aria-labelledby="sec-arkiv">
        <h2 id="sec-arkiv" className="section-block__title">
          Dina arkiv
        </h2>
        {jobs.length === 0 ? (
          <p className="section-block__empty">Du har inte begärt någon export än.</p>
        ) : (
          <ul className="card card--group export-list">
            {jobs.map((job) => (
              <li key={job.id} className="export-row">
                <div className="export-row__main">
                  <p className="export-row__status">{statusHeading(job)}</p>
                  <p className="meta">{jobDetail(job)}</p>
                  {link?.id === job.id ? (
                    <p className="meta">
                      Hämtningen har startat.{' '}
                      <a href={link.url}>Öppna länken igen</a> — den gäller i {LINK_DAYS} dagar.
                    </p>
                  ) : null}
                </div>
                {job.status === 'ready' && !demo ? (
                  <button
                    type="button"
                    className="btn"
                    onClick={() => void download(job.id)}
                    disabled={busy}
                  >
                    Hämta arkivet
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <footer className="page-foot">
        <Link to="/konto" className="page-foot__link">
          Tillbaka till kontot
        </Link>
      </footer>
    </article>
  );
}

function statusHeading(job: ExportJobDto): string {
  switch (job.status) {
    case 'pending':
    case 'running':
      return 'Förbereds…';
    case 'ready':
      return 'Klar att hämta';
    case 'failed':
      return 'Exporten misslyckades';
    case 'expired':
      return 'Arkivet har försvunnit';
  }
}

/**
 * The line under the status.
 *
 * Counts only once the job has run: a "0 händelser" while the archive is still being
 * built reads as an empty memory, which is the one thing an export must never suggest.
 */
function jobDetail(job: ExportJobDto): string {
  const requested = `Begärd ${swedishMoment(job.requestedAt)}`;

  if (job.status === 'failed') {
    return `${requested} · ${job.error ?? 'Försök igen, eller begär en ny export.'}`;
  }
  if (job.status === 'expired') {
    return `${requested} · Arkiv sparas i ${LINK_DAYS} dagar. Begär en ny export.`;
  }
  if (job.status !== 'ready') {
    return `${requested} · Arkivet byggs i bakgrunden.`;
  }

  const parts = [
    countLabel(job.counts.events, 'händelse', 'händelser'),
    countLabel(job.counts.items, 'minne', 'minnen'),
    countLabel(job.counts.documents, 'dokument', 'dokument'),
    job.byteSizeLabel,
  ].filter((part): part is string => Boolean(part));

  return [requested, ...parts, `försvinner ${swedishMoment(job.expiresAt)}`].join(' · ');
}

function countLabel(count: number | null, singular: string, plural: string): string | null {
  if (count === null) return null;
  return `${count.toLocaleString('sv-SE')} ${count === 1 ? singular : plural}`;
}

/** "15 september 14:32", as a person reads a moment. */
function swedishMoment(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleString('sv-SE', {
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  });
}
