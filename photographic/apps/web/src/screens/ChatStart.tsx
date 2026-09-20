import { ContributionPreference } from '../components/ContributionPreference.js';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { detect } from '@photographic/connect/detect';
import { buildClients, chatLaunch } from '@photographic/connect/clients';
import type { ClientDescriptor, ConnectAction, ConnectPayload } from '@photographic/connect';
import { apiFetch } from '../api/client.js';
import { getAccount } from '../api/account.js';
import { loadAccountDemo } from '../data/demo.js';
import { CHAT_CLIENTS, lastChatChoice, rememberChatChoice } from '../data/chat-choice.js';
import { listClients } from '../api/clients.js';
import type { ClientHealthDto } from '../api/types.js';
import { CalmState, LoadingState } from '../components/CalmState.js';
import { useRoomData, type LoadState } from '../hooks/useRoomData.js';
import { useConnectionCheck } from '../hooks/useConnectionCheck.js';

const CLIENT_MARKS: Record<ClientDescriptor['id'], string> = {
  chatgpt: 'GPT', codex: 'Co', cursor: 'Cu', claude: 'Cl', 'claude-code': 'CC', vscode: 'VS',
};

export function ChatStart() {
  const [retry, setRetry] = useState(0);
  const [healthRefresh, setHealthRefresh] = useState(0);
  useEffect(() => {
    const refresh = () => setHealthRefresh(value => value + 1);
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, []);
  // Keep the layout stable during a click. The next visit picks up the device choice.
  const [lastChoice] = useState(lastChatChoice);
  const platform = detect(navigator.userAgent, navigator.maxTouchPoints).platform;
  const account = useRoomData(`chat-account-${retry}`, loadAccountDemo, getAccount);
  const health = useRoomData(`chat-health-${retry}-${healthRefresh}`, () => [] as ClientHealthDto[],
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
    <p className="chat-start__explanation">Koppla den app du vill använda. Vi hjälper dig med första starten och kontrollerar när ditt minne har hämtats.</p>
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
  const platform = detect(navigator.userAgent, navigator.maxTouchPoints).platform;
  const launch = chatLaunch(client.id, platform)!;
  const check = useConnectionCheck(client.id);
  const [guideOpen, setGuideOpen] = useState(false);
  const [copyState, setCopyState] = useState<'copied' | 'manual' | null>(null);
  const previous = (health.status === 'ready' ? health.data : []).filter((entry) => client.agentClients.some((name) => name === entry.agentClient)
    && !entry.revoked && entry.profileDelivered)
    .sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt))[0];
  const quick = client.quickSetup;
  const needsSetup = health.status === 'ready' && !previous && !check.hasReceipt;

  function openChat() {
    rememberChatChoice(client.id);
    check.start('chat');
  }

  function startSetup() {
    setGuideOpen(true);
    check.start('setup');
    // The link itself stays synchronous, preserving the browser's user gesture.
    // The adjacent hint explicitly tells the person that this copies the public URL.
    if (quick?.copyValue) {
      try {
        void navigator.clipboard.writeText(quick.copyValue)
          .then(() => setCopyState('copied'), () => setCopyState('manual'));
      } catch { setCopyState('manual'); }
    }
  }

  const receipt = check.state === 'waiting' ? `Vi kontrollerar automatiskt när ${client.displayName} hämtar ditt minne.`
    : check.state === 'connected' ? `${client.displayName} har hämtat ditt minne. Kvittot gäller appen; vi kan inte avgöra vilken chatt som hämtade det.`
    : check.state === 'timed_out' ? 'Ingen ny hämtning ännu. Du behöver inte lägga till kopplingen igen om den redan finns. Öppna chatten och be din AI hämta ditt minne.'
    : check.state === 'error' ? 'Kontrollen kunde inte slutföras. Du kan fortsätta i appen och försöka igen här.'
    : check.state === 'demo' ? 'Förhandsvisning — ingen leverans kontrolleras.' : null;

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
          : check.hasReceipt ? 'Minnet har hämtats under det här besöket.'
          : health.status === 'error' ? 'Kopplingen kunde inte kontrolleras just nu.'
          : health.status === 'loading' ? 'Kontrollerar tidigare hämtningar…' : 'Börja med att koppla ditt minne'}</p>
      </div>
      {!launch.url ? <button className="btn chat-start__open" aria-label="Öppna på datorn" disabled>På datorn</button>
        : needsSetup && quick ? <a className="btn chat-start__open" href={quick.url}
          target={quick.url.startsWith('https:') ? '_blank' : undefined} rel="noopener noreferrer"
          aria-label={`Koppla ${client.displayName}`} aria-describedby={`setup-hint-${client.id}`} onClick={startSetup}>
          Koppla<span aria-hidden="true"> ↗</span>
        </a>
        : <a className={`btn${preferred ? ' btn--brand' : ''} chat-start__open`} href={launch.url}
          aria-label={`Öppna ${client.displayName}`} rel="noopener noreferrer" onClick={openChat}>
          Öppna<span aria-hidden="true"> ↗</span>
        </a>}
    </div>
    {launch.url && needsSetup && quick && <p id={`setup-hint-${client.id}`} className="chat-start__note">{quick.hint}</p>}
    {launch.url && !needsSetup && launch.activationNote && <p className="chat-start__note">{launch.activationNote}</p>}
    {!launch.url && <p className="chat-start__note">Finns här när du använder Photographic på datorn.</p>}
    {receipt && <p className="chat-start__receipt" role="status">{receipt}</p>}
    <div className="chat-start__support">
      <details className="chat-start__setup chat-start__setup--connection" open={guideOpen}>
        <summary aria-label={`Koppla ${client.displayName} till Photographic`}
          onClick={event => { event.preventDefault(); setGuideOpen(!guideOpen); }}>
          {previous || check.hasReceipt ? 'Hantera kopplingen' : 'Så kommer du igång'}
        </summary>
        {check.state !== 'connected' && <>
          {copyState === 'copied' && <p role="status">Adressen är kopierad. Klistra in den i {client.displayName}.</p>}
          {copyState === 'manual' && <div className="chat-start__manual">
            <p role="status">Kopieringen gick inte. Markera och kopiera adressen här:</p>
            <input aria-label={`Adress för ${client.displayName}`} readOnly value={quick?.copyValue ?? ''} onFocus={event => event.target.select()} />
          </div>}
          <ol>{(quick?.steps ?? client.steps).map(step => <li key={step}>{step}</li>)}</ol>
          {quick && launch.url && <a className="chat-start__fallback" href={quick.url}
            target={quick.url.startsWith('https:') ? '_blank' : undefined} rel="noopener noreferrer" onClick={startSetup}>
            {quick.copyValue ? 'Kopiera adressen och öppna inställningarna' : 'Lägg till Photographic'}
          </a>}
          {client.caveats.map(note => <p key={note}>{note}</p>)}
        </>}
        {launch.url && <div className="chat-start__continue">
          {check.state !== 'connected' && <>
            <h4>Kopplingen finns redan eller är tillagd?</h4>
            {launch.activationNote && <p>{launch.activationNote}</p>}
            <p>Öppna chatten och be din AI hämta ditt minne från Photographic. Vi kontrollerar hämtningen automatiskt.</p>
          </>}
          <a className="btn btn--brand" href={launch.url} aria-label={`Öppna ${client.displayName} efter koppling`}
            rel="noopener noreferrer" onClick={openChat}>{check.state === 'connected' ? `Fortsätt i ${client.displayName}` : 'Öppna chatten'} ↗</a>
        </div>}
        {(check.state === 'error' || check.state === 'timed_out') && <button className="btn" onClick={check.retry}>Försök kontrollera igen</button>}
        <details className="chat-start__troubleshoot">
          <summary>Fler sätt och hjälp</summary>
          <SetupAction action={client.primary} />
          {client.secondary.filter(action => action.type === 'deeplink').map(action => <SetupAction key={action.label} action={action} />)}
          {quick?.steps && <ol>{client.steps.map(step => <li key={step}>{step}</li>)}</ol>}
          <p>{client.remedy}</p>
          <blockquote>{client.verifyPrompt}</blockquote>
          <CopyText value={client.verifyPrompt} label="Kopiera kontrollfrågan" />
        </details>
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
