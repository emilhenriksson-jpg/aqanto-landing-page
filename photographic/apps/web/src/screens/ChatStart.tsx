import { ContributionPreference } from '../components/ContributionPreference.js';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { detect } from '@photographic/connect/detect';
import { buildClients, chatLaunch } from '@photographic/connect/clients';
import type { ClientDescriptor, ConnectAction, ConnectPayload, VerificationHandle, VerificationState } from '@photographic/connect';
import { apiFetch } from '../api/client.js';
import { isDemoMode } from '../api/config.js';
import { getAccount } from '../api/account.js';
import { loadAccountDemo } from '../data/demo.js';
import { CHAT_CLIENTS, lastChatChoice, rememberChatChoice } from '../data/chat-choice.js';
import { listClients } from '../api/clients.js';
import type { ClientHealthDto } from '../api/types.js';
import { CalmState, LoadingState } from '../components/CalmState.js';
import { useRoomData, type LoadState } from '../hooks/useRoomData.js';

const CLIENT_MARKS: Record<ClientDescriptor['id'], string> = {
  chatgpt: 'GPT', codex: 'Co', cursor: 'Cu', claude: 'Cl', 'claude-code': 'CC', vscode: 'VS',
};

export function ChatStart() {
  const [retry, setRetry] = useState(0);
  // Keep the layout stable during a click. The next visit picks up the device choice.
  const [lastChoice] = useState(lastChatChoice);
  const platform = detect(navigator.userAgent, navigator.maxTouchPoints).platform;
  const account = useRoomData(`chat-account-${retry}`, loadAccountDemo, getAccount);
  const health = useRoomData(`chat-health-${retry}`, () => [] as ClientHealthDto[],
    async () => (await listClients()).clients);
  const state = useRoomData(`chat-start-${retry}`, () =>
    buildClients({ mcpUrl: 'https://mcp.photographic.space/mcp', connectPageUrl: '/connect' }),
    async () => (await apiFetch<ConnectPayload>('/v1/connect')).clients);
  const preferred = lastChoice && chatLaunch(lastChoice, platform)?.url ? lastChoice : null;
  const ordered = [...CHAT_CLIENTS].sort((a, b) => {
    const rank = (id: typeof a) => !chatLaunch(id, platform)?.url ? 2 : id === preferred ? 0 : 1;
    return rank(a) - rank(b);
  });
  const firstName = account.status === 'ready' ? account.data.firstName?.trim() : null;

  if (state.status === 'loading') return <LoadingState label="Förbereder din start…" />;
  if (state.status === 'error') return <>
    <CalmState title="Din AI, ditt minne" message={state.message} />
    <button className="btn" onClick={() => setRetry((value) => value + 1)}>Försök igen</button>
  </>;

  return <article className="page chat-start">
    <header className="page-head">
      <h1 className="page-head__title">{firstName ? `Hej, ${firstName}.` : 'Hej.'}</h1>
      <p className="page-head__lede">En tanke, en plan eller bara dagen som gått.<br />Börja där du är.</p>
    </header>
    <div className="chat-start__section-head"><h2>Öppna en chatt</h2><span>Välj den app du vill prata i.</span></div>
    <section aria-label="Öppna en chatt" className="chat-start__clients">
      {ordered.map((id) => {
        const client = state.data.find((entry) => entry.id === id);
        return client?.launch ? <LaunchCard key={id} client={client} preferred={id === preferred}
          health={health} /> : null;
      })}
    </section>
    <p className="chat-start__explanation">Koppla appen första gången så att den kan hämta ditt minne. Att öppna en chatt aktiverar inte kopplingen.</p>
    <div className="chat-start__section-head chat-start__section-head--memory"><h2>Här finns ditt sammanhang</h2><span>Du bestämmer vad som stannar.</span></div>
    <section className="chat-start__memory" aria-label="Ditt minne">
      <Link to="/personligt"><span className="chat-start__memory-icon" aria-hidden="true">◎</span><strong>Ditt personliga rum<span aria-hidden="true">↗</span></strong><span>Det som gör dig till dig.</span></Link>
      <Link to="/rum"><span className="chat-start__memory-icon" aria-hidden="true">▦</span><strong>Dina rum<span aria-hidden="true">↗</span></strong><span>Människor, projekt och det ni delar.</span></Link>
      <Link to="/kalender"><span className="chat-start__memory-icon" aria-hidden="true">◷</span><strong>Din kalender<span aria-hidden="true">↗</span></strong><span>Det som hänt med ditt minne.</span></Link>
    </section>
    <ContributionPreference />
    <footer className="page-foot"><Link to="/klienter" className="page-foot__link">Se vilka AI:er som har fått ditt minne</Link></footer>
  </article>;
}

function LaunchCard({ client, health, preferred }: { client: ClientDescriptor; health: LoadState<ClientHealthDto[]>; preferred: boolean }) {
  // Browser touch information distinguishes iPad desktop mode from a Mac.
  const platform = detect(navigator.userAgent, navigator.maxTouchPoints).platform;
  const launch = chatLaunch(client.id, platform)!;
  const [handle, setHandle] = useState<VerificationHandle | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const previous = (health.status === 'ready' ? health.data : []).filter((entry) => client.agentClients.some((name) => name === entry.agentClient)
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
            ? `${client.displayName} har hämtat ditt minne. Kvittot gäller appen; vi kan inte avgöra vilken chatt som hämtade det.`
            : 'Ingen ny hämtning bekräftad. Välj Photographic i chatten och be din AI hämta ditt minne med kontrollfrågan nedan.');
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
    setStatus(`Väntar på att ${client.displayName} hämtar ditt minne.`);
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

  return <article className={`chat-start__card${preferred ? ' chat-start__card--preferred' : ''}`}>
    <div className="chat-start__row">
    <span className="chat-start__monogram" aria-hidden="true">{CLIENT_MARKS[client.id]}</span>
    <div className="chat-start__identity">
    <div className="chat-start__card-head">
      <h3>{client.displayName}</h3>
      {preferred && <span className="chat-start__last">Senast vald här</span>}
    </div>
    <p className="chat-start__status">{previous
      ? `Senast hämtat ${new Date(previous.lastSeenAt).toLocaleString('sv-SE', { dateStyle: 'short', timeStyle: 'short' })}. Det bekräftar inte kopplingen i en ny chatt.`
      : health.status === 'error' ? 'Kopplingen kunde inte kontrolleras just nu.' : health.status === 'loading' ? 'Kontrollerar tidigare hämtningar…' : 'Inte verifierad ännu'}</p>
    </div>
    {launch.url ? <a className={`btn${preferred ? ' btn--brand' : ''} chat-start__open`} href={launch.url}
      aria-label={`Öppna ${client.displayName}`}
      rel="noopener noreferrer"
      onClick={() => {
        rememberChatChoice(client.id);
        verify().catch(() => setStatus('Kunde inte kontrollera leveransen.'));
      }}>
      Öppna<span aria-hidden="true"> ↗</span>
    </a> : <button className="btn chat-start__open" aria-label="Öppna på datorn" disabled>På datorn</button>}
    </div>
    {launch.url && launch.activationNote && <p className="chat-start__note">{launch.activationNote}</p>}
    {!launch.url && <p className="chat-start__note">Finns här när du använder Photographic på datorn.</p>}
    {status && <p className="chat-start__receipt" role="status">{status}</p>}
    <div className="chat-start__support">
    <details className="chat-start__setup chat-start__setup--connection">
      <summary aria-label={previous ? `Hantera kopplingen till ${client.displayName}` : `Koppla ${client.displayName} till Photographic`}>{previous ? 'Hantera kopplingen' : 'Koppla Photographic'}</summary>
      <SetupAction action={client.primary} />
      {client.secondary.filter((action) => action.type === 'deeplink').map((action) => <SetupAction key={action.label} action={action} />)}
      <ol>{client.steps.map((step) => <li key={step}>{step}</li>)}</ol>
      {client.caveats.map((note) => <p key={note}>{note}</p>)}
      <p>Välj Photographic i chatten och skicka kontrollfrågan. En personlig hälsning eller ett svar från AI:ns eget minne bekräftar inte kopplingen.</p>
      <blockquote>{client.verifyPrompt}</blockquote>
      <CopyText value={client.verifyPrompt} label="Kopiera kontrollfrågan" />
      <button className="btn" disabled={checking} onClick={() => void verify().catch(() => setStatus('Kunde inte kontrollera leveransen.'))}>Kontrollera kopplingen</button>
    </details>
    <details className="chat-start__setup">
      <summary aria-label={`Hjälp med ${client.displayName}`}>Hjälp</summary>
      <p>{launch.note}</p>
      {launch.url && <p>Öppnades inte appen? Kontrollera att den är installerad och tillåt webbläsaren att öppna den. På iPhone kan du hålla inne länken och välja att öppna i appen.</p>}
      {launch.fallbackUrl && <a href={launch.fallbackUrl} target="_blank" rel="noopener noreferrer" className="chat-start__fallback">Öppna i webbläsaren</a>}
    </details>
    </div>
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
