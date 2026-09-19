import { ContributionPreference } from '../components/ContributionPreference.js';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { detect } from '@photographic/connect/detect';
import { buildClients, chatLaunch } from '@photographic/connect/clients';
import type { ClientDescriptor, ConnectAction, ConnectPayload, VerificationHandle, VerificationState } from '@photographic/connect';
import { apiFetch } from '../api/client.js';
import { isDemoMode } from '../api/config.js';
import { listClients } from '../api/clients.js';
import type { ClientHealthDto } from '../api/types.js';
import { CalmState, LoadingState } from '../components/CalmState.js';
import { Wordmark } from '../components/Wordmark.js';
import { useRoomData } from '../hooks/useRoomData.js';

const ORDER = ['chatgpt', 'codex', 'cursor', 'claude'];

export function ChatStart() {
  const [retry, setRetry] = useState(0);
  const state = useRoomData(`chat-start-${retry}`, () => ({
    clients: buildClients({ mcpUrl: 'https://mcp.photographic.space/mcp', connectPageUrl: '/connect' }),
    health: [] as ClientHealthDto[],
  }), async () => {
    const [payload, health] = await Promise.all([
      apiFetch<ConnectPayload>('/v1/connect'), listClients(),
    ]);
    return { clients: payload.clients, health: health.clients };
  });

  if (state.status === 'loading') return <LoadingState label="Förbereder din start…" />;
  if (state.status === 'error') return <>
    <CalmState title="Din AI, ditt minne" message={state.message} />
    <button className="btn" onClick={() => setRetry((value) => value + 1)}>Försök igen</button>
  </>;

  return <article className="page chat-start">
    <header className="page-head">
      <Wordmark large />
      <h1 className="page-head__title">Vad vill du prata om?</h1>
      <p className="page-head__lede">Välj din AI och börja där du är. Ditt personliga minne, en överblick över dina rum och det senaste i kalendern följer med när AI:n hämtar din kontext.</p>
    </header>
    <ContributionPreference />
    <section aria-label="Öppna en chatt" className="chat-start__clients">
      {ORDER.map((id) => {
        const client = state.data.clients.find((entry) => entry.id === id);
        return client?.launch ? <LaunchCard key={id} client={client} health={state.data.health} /> : null;
      })}
    </section>
    <p className="chat-start__explanation">Första gången behöver du godkänna att din AI får använda Photographic. Därefter kan du komma tillbaka hit och öppna nästa samtal. Du behöver inte välja rum.</p>
    <section className="chat-start__memory" aria-label="Ditt minne">
      <Link to="/personligt"><strong>Ditt personliga rum</strong><span>Vem du är, vad som är viktigt och hur din AI ska hjälpa dig.</span></Link>
      <Link to="/rum"><strong>Dina rum</strong><span>En kort överblick från början. Mer sammanhang hämtas när ni pratar om ett rum.</span></Link>
      <Link to="/kalender"><strong>Din kalender</strong><span>Senaste händelser och trådar att fortsätta på, även från en annan AI.</span></Link>
    </section>
    <footer className="page-foot"><Link to="/klienter" className="page-foot__link">Se vilka AI:er som har fått ditt minne</Link></footer>
  </article>;
}

function LaunchCard({ client, health }: { client: ClientDescriptor; health: ClientHealthDto[] }) {
  // Browser touch information distinguishes iPad desktop mode from a Mac.
  const platform = detect(navigator.userAgent, navigator.maxTouchPoints).platform;
  const launch = chatLaunch(client.id, platform)!;
  const [handle, setHandle] = useState<VerificationHandle | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const previous = health.filter((entry) => client.agentClients.some((name) => name === entry.agentClient)
    && !entry.revoked && entry.profileDelivered)
    .sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt))[0];

  useEffect(() => {
    if (!handle) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await apiFetch<VerificationState>('/v1/connect/status', {
          method: 'POST', body: JSON.stringify({ handle }),
        });
        if (cancelled) return;
        if (result.status === 'waiting') {
          timer = setTimeout(() => void poll().catch(() => { if (!cancelled) setStatus('Kunde inte kontrollera leveransen.'); }), 2500);
        } else {
          setChecking(false);
          setStatus(result.status === 'connected'
            ? `Ny kontext skickad till ${client.displayName}.`
            : 'Ingen ny kontext har hämtats ännu. Kontrollera att Photographic är valt i chatten och börja prata.');
        }
      } catch {
        if (!cancelled) {
          setChecking(false);
          setStatus('Kunde inte kontrollera leveransen. Försök igen när du är tillbaka.');
        }
      }
    };
    poll().catch(() => { if (!cancelled) setStatus('Kunde inte kontrollera leveransen.'); });
    return () => { cancelled = true; clearTimeout(timer); };
  }, [handle, client.displayName]);

  async function verify() {
    if (checking) return;
    if (isDemoMode()) { setStatus('Förhandsvisning — ingen leverans kontrolleras.'); return; }
    setHandle(null);
    setChecking(true);
    setStatus('Väntar på att din AI hämtar kontext. Att appen öppnas betyder inte att minnet har skickats.');
    try {
      const result = await apiFetch<{ handle: VerificationHandle }>('/v1/connect/verify', {
        method: 'POST', body: JSON.stringify({ clientId: client.id }),
      });
      setHandle(result.handle);
    } catch {
      setChecking(false);
      setStatus('Kunde inte kontrollera leveransen. Kontrollera kopplingen nedan.');
    }
  }

  return <article className="chat-start__card">
    <h2>{client.displayName}</h2>
    <p className="chat-start__status">{previous
      ? `Kontext skickades senast ${new Date(previous.lastSeenAt).toLocaleString('sv-SE', { dateStyle: 'short', timeStyle: 'short' })}.`
      : 'Ingen bekräftad leverans ännu.'}</p>
    {launch.url ? <a className="btn btn--brand chat-start__open" href={launch.url}
      rel="noopener noreferrer"
      onClick={() => { verify().catch(() => setStatus('Kunde inte kontrollera leveransen.')); }}>
      Öppna {client.displayName}<span aria-hidden="true"> ↗</span>
    </a> : <button className="btn chat-start__open" disabled>Öppna på datorn</button>}
    <p className="chat-start__note">{launch.note}</p>
    {launch.url && <p className="chat-start__note">Öppnades inte appen? Kontrollera att den är installerad och tillåt webbläsaren att öppna den. På iPhone kan du hålla inne länken och välja att öppna i appen.</p>}
    {launch.url && <details className="chat-start__setup">
      <summary>Hjälp med starten</summary>
      <p>Kontrollera att Photographic är anslutet i din AI. Instruktionerna följer med genom kopplingen. Du kan börja med en vanlig hälsning eller kopiera den här.</p>
      <CopyText value={launch.prompt} label="Kopiera hälsning" />
    </details>}
    {launch.fallbackUrl && <a href={launch.fallbackUrl} target="_blank" rel="noopener noreferrer" className="chat-start__fallback">Öppna i webbläsaren</a>}
    {status && <p className="chat-start__receipt" role="status">{status}</p>}
    {status && !checking && <button className="btn btn--quiet" onClick={() => void verify().catch(() => setStatus('Kunde inte kontrollera leveransen.'))}>Kontrollera nästa hämtning</button>}
    <details className="chat-start__setup">
      <summary>Koppla {client.displayName} första gången</summary>
      <SetupAction action={client.primary} />
      <ol>{client.steps.map((step) => <li key={step}>{step}</li>)}</ol>
      {client.caveats.map((note) => <p key={note}>{note}</p>)}
      <button className="btn" disabled={checking} onClick={() => void verify().catch(() => setStatus('Kunde inte kontrollera leveransen.'))}>Kontrollera kopplingen</button>
    </details>
  </article>;
}

function SetupAction({ action }: { action: ConnectAction }) {
  if (action.type === 'deeplink') return <a className="btn" href={action.url}>{action.label}</a>;
  const value = action.type === 'copy' ? action.value : action.command;
  return <><code className="chat-start__code">{value}</code><CopyText value={value} label={action.type === 'command' ? 'Kopiera kommandot' : action.label} /></>;
}

function CopyText({ value, label }: { value: string; label: string }) {
  const [message, setMessage] = useState<string | null>(null);
  const [manual, setManual] = useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(value); setMessage('Kopierat'); setManual(false); }
    catch { setMessage('Markera och kopiera texten nedan.'); setManual(true); }
  }
  return <div className="chat-start__copy"><button className="btn btn--quiet" onClick={() => void copy().catch(() => setManual(true))}>{label}</button>
    {message && <span role="status">{message}</span>}
    {manual && <textarea aria-label={label} value={value} readOnly onFocus={(event) => event.target.select()} />}
  </div>;
}
