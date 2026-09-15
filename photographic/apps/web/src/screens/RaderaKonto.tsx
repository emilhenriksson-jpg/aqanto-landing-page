import { useState } from 'react';
import { Link } from 'react-router-dom';

import {
  cancelDeletion,
  getDeletionState,
  isDemoMode,
  requestDeletion,
  type DeletionReceiptDto,
  type DeletionStateDto,
} from '../api/index.js';
import { CalmState, LoadingState } from '../components/CalmState.js';
import { Wordmark } from '../components/Wordmark.js';
import { calmErrorMessage } from '../data/load.js';
import { useRoomData } from '../hooks/useRoomData.js';

/**
 * "Radera konto" — the other half of the promise the export makes.
 *
 * A memory product that cannot be left is a memory product nobody should hand a decade of
 * their life to, so this screen exists to be pressed rather than to reassure. Three things
 * shape it.
 *
 * The consent copy is served by the API, not written here: what a person reads before
 * deleting their account is the same wording the invite promised them, and two copies of
 * it would drift.
 *
 * Nothing is preselected. `contributions` has no default in the schema either, because a
 * default there would be this product deciding on someone's behalf about other people's
 * memory.
 *
 * And the confirmation is honest about the one thing a person is most likely to assume
 * wrongly: the thirty-day trash is about single memories they deleted, and it does not
 * bring back an account. On the immediate path it says so and asks for the phrase to be
 * typed, which is what stops a double-submit from skipping thirty days of recoverability.
 *
 * Live: GET/POST/DELETE /v1/account/deletion behind VITE_USE_DEMO=0.
 */
export function RaderaKonto() {
  const state = useRoomData(
    'radera-konto',
    (): DeletionStateDto => DEMO_DELETION_STATE,
    () => getDeletionState(),
  );

  if (state.status === 'loading') return <LoadingState label="Hämtar kontots läge…" />;
  if (state.status === 'error') {
    return <CalmState title="Radera konto" message={state.message} />;
  }

  return <RaderaKontoReady initial={state.data} />;
}

/**
 * The phrase the immediate path requires, typed by the person.
 *
 * `IMMEDIATE_CONFIRMATION` in `apps/rest/src/routes/account.ts` is the authority: it
 * validates the typed phrase server-side and refuses the request without it. This copy
 * exists so the field can say what to write, and if the two ever drift the server is the
 * one that decides — which fails closed rather than open.
 */
const IMMEDIATE_PHRASE = 'radera nu';

/** Neither choice is made for the person, so neither is selected. */
type Contributions = 'keep' | 'remove' | null;
type Timing = 'freeze' | 'immediate' | null;

const DEMO_DELETION_STATE: DeletionStateDto = {
  pending: null,
  freezeDays: 30,
  copy: {
    freeze: '',
    immediate: '',
    sharedRooms: '',
    removeContributions: '',
  },
};

function RaderaKontoReady({ initial }: { initial: DeletionStateDto }) {
  const demo = isDemoMode();
  const [state, setState] = useState(initial);
  const [contributions, setContributions] = useState<Contributions>(null);
  const [timing, setTiming] = useState<Timing>(null);
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<DeletionReceiptDto | null>(null);

  const { copy, freezeDays, pending } = state;
  const immediate = timing === 'immediate';
  const phraseOk = !immediate || typed.trim().toLowerCase() === IMMEDIATE_PHRASE;

  async function submit() {
    if (!contributions || !timing) return;
    setError(null);
    setBusy(true);
    try {
      const result = await requestDeletion({
        contributions,
        immediate,
        ...(immediate ? { confirm: typed.trim() } : {}),
      });
      setReceipt(result);
      setConfirming(false);
      const refreshed = await getDeletionState().catch(() => null);
      if (refreshed) setState(refreshed);
    } catch (caught) {
      setError(calmErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    setError(null);
    setBusy(true);
    try {
      const { notice } = await cancelDeletion();
      setReceipt(null);
      setContributions(null);
      setTiming(null);
      setTyped('');
      const refreshed = await getDeletionState().catch(() => null);
      if (refreshed) setState(refreshed);
      setError(notice);
    } catch (caught) {
      setError(calmErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="page page--radera">
      <header className="page-head">
        <Wordmark />
        <h1 className="page-head__title">Radera konto</h1>
        <p className="page-head__lede">
          Du ska kunna lämna på riktigt, med allt ditt med dig eller borta för gott. Välj vad
          som händer med dina bidrag i delade rum, och när raderingen ska ske.
        </p>
      </header>

      <p className="radera-first">
        <Link to="/konto/export">Exportera ditt minne först</Link> om du vill behålla en kopia.
        Efter raderingen finns ingenting att exportera.
      </p>

      {pending ? (
        <section className="card radera-panel" aria-labelledby="sec-pagaende">
          <h2 id="sec-pagaende" className="section-block__title">
            En radering är på gång
          </h2>
          <p className="radera-panel__body">
            {pending.immediate
              ? 'Kontot raderas i nästa körning.'
              : `Kontot raderas ${swedishDate(pending.executeAfter)} — ${daysLabel(pending.daysRemaining)} kvar att ändra dig.`}{' '}
            {pending.contributions === 'remove'
              ? 'Dina bidrag i delade rum tas bort först.'
              : 'Dina bidrag i delade rum står kvar, utan ditt namn.'}
          </p>
          {!demo ? (
            <button type="button" className="btn" onClick={() => void cancel()} disabled={busy}>
              Avbryt raderingen
            </button>
          ) : null}
        </section>
      ) : null}

      {receipt ? (
        <section className="card radera-panel" aria-labelledby="sec-kvitto">
          <h2 id="sec-kvitto" className="section-block__title">
            Begäran är registrerad
          </h2>
          <p className="radera-panel__body">{receipt.notice}</p>
          <p className="meta">
            {receipt.clientsDisconnected === 0
              ? 'Inga anslutna AI:er fanns att koppla bort.'
              : receipt.clientsDisconnected === 1
                ? '1 ansluten AI kopplades bort.'
                : `${receipt.clientsDisconnected} anslutna AI:er kopplades bort.`}{' '}
            {receipt.sharedRooms}
          </p>
        </section>
      ) : null}

      {!pending && !receipt ? (
        <>
          <section className="section-block" aria-labelledby="sec-bidrag">
            <h2 id="sec-bidrag" className="section-block__title">
              Dina bidrag i delade rum
            </h2>
            {copy.sharedRooms ? <p className="radera-help">{copy.sharedRooms}</p> : null}
            <fieldset className="radera-choices">
              <legend className="radera-choices__legend">Välj ett — inget är förvalt.</legend>
              <Choice
                name="contributions"
                value="keep"
                checked={contributions === 'keep'}
                onChange={() => setContributions('keep')}
                title="Låt dem stå kvar"
                detail={
                  'De andra medlemmarna behåller sitt gemensamma minne. Dina rader visas som ' +
                  '"Borttagen användare".'
                }
              />
              <Choice
                name="contributions"
                value="remove"
                checked={contributions === 'remove'}
                onChange={() => setContributions('remove')}
                title="Ta bort mina bidrag först"
                detail={copy.removeContributions}
              />
            </fieldset>
          </section>

          <section className="section-block" aria-labelledby="sec-nar">
            <h2 id="sec-nar" className="section-block__title">
              När raderingen sker
            </h2>
            <fieldset className="radera-choices">
              <legend className="radera-choices__legend">
                Kontot slutar vara nåbart direkt i båda fallen.
              </legend>
              <Choice
                name="timing"
                value="freeze"
                checked={timing === 'freeze'}
                onChange={() => setTiming('freeze')}
                title={`Om ${freezeDays} dagar`}
                detail={copy.freeze}
              />
              <Choice
                name="timing"
                value="immediate"
                checked={timing === 'immediate'}
                onChange={() => setTiming('immediate')}
                title="Nu, utan ångerfrist"
                detail={copy.immediate}
              />
            </fieldset>
          </section>

          {confirming ? (
            <section className="card radera-panel radera-panel--confirm" aria-labelledby="sec-bekrafta">
              <h2 id="sec-bekrafta" className="section-block__title">
                {immediate ? 'Radera nu — det går inte att ångra' : 'Bekräfta raderingen'}
              </h2>
              <p className="radera-panel__body">
                {immediate
                  ? 'Ditt privata minne, dina dokument och dina filer tas bort permanent i nästa ' +
                    'körning. Det finns ingen ångerfrist och ingen kopia hos oss efteråt.'
                  : `Kontot låses nu och raderas permanent om ${freezeDays} dagar. Fram till dess ` +
                    'kan du logga in, exportera och avbryta.'}
              </p>
              {/*
                The one thing a person is likeliest to assume wrongly. The trash is the
                safeguard behind every deleted memory in this product, and it is easy to
                read it as covering this too — so it is said before the button, not after.
              */}
              <p className="radera-panel__body">
                Papperskorgens 30 dagar gäller enskilda minnen du tagit bort. De gäller inte ett
                raderat konto: {immediate ? 'ingenting här kan hämtas tillbaka.' : 'efter de 30 dagarna finns inget att hämta tillbaka.'}
              </p>
              <p className="meta">
                {contributions === 'remove'
                  ? 'Dina bidrag i delade rum tas bort först och hamnar i rummets papperskorg.'
                  : 'Dina bidrag i delade rum står kvar, utan ditt namn.'}
              </p>

              {immediate ? (
                <label className="radera-phrase">
                  <span className="radera-phrase__label">
                    Skriv <span className="mono">{IMMEDIATE_PHRASE}</span> för att bekräfta
                  </span>
                  <input
                    className="radera-phrase__input"
                    type="text"
                    autoComplete="off"
                    value={typed}
                    onChange={(event) => setTyped(event.target.value)}
                    aria-label={`Skriv ${IMMEDIATE_PHRASE} för att bekräfta`}
                  />
                </label>
              ) : null}

              <div className="radera-actions">
                <button
                  type="button"
                  className="btn"
                  onClick={() => void submit()}
                  disabled={busy || demo || !phraseOk}
                >
                  {immediate ? 'Radera nu' : `Radera om ${freezeDays} dagar`}
                </button>
                <button
                  type="button"
                  className="btn btn--quiet"
                  onClick={() => {
                    setConfirming(false);
                    setTyped('');
                  }}
                  disabled={busy}
                >
                  Avbryt
                </button>
              </div>
              {demo ? (
                <p className="meta">
                  Demoläge: ingen riktig radering begärs härifrån.
                </p>
              ) : null}
            </section>
          ) : (
            <button
              type="button"
              className="btn radera-continue"
              onClick={() => setConfirming(true)}
              disabled={!contributions || !timing}
            >
              Fortsätt
            </button>
          )}
        </>
      ) : null}

      {error ? (
        <p className="meta radera-error" role="alert">
          {error}
        </p>
      ) : null}

      <footer className="page-foot">
        <Link to="/konto" className="page-foot__link">
          Tillbaka till kontot
        </Link>
      </footer>
    </article>
  );
}

function Choice({
  name,
  value,
  checked,
  onChange,
  title,
  detail,
}: {
  name: string;
  value: string;
  checked: boolean;
  onChange: () => void;
  title: string;
  detail: string;
}) {
  return (
    <label className={checked ? 'radera-choice radera-choice--on' : 'radera-choice'}>
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={onChange}
        className="radera-choice__input"
      />
      <span className="radera-choice__text">
        <span className="radera-choice__title">{title}</span>
        {detail ? <span className="radera-choice__detail meta">{detail}</span> : null}
      </span>
    </label>
  );
}

function daysLabel(days: number): string {
  if (days <= 0) return 'mindre än en dag';
  return days === 1 ? '1 dag' : `${days} dagar`;
}

/** "14 oktober 2026" — a date a person can hold on to. */
function swedishDate(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleDateString('sv-SE', { day: 'numeric', month: 'long', year: 'numeric' });
}
