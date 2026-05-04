const states = {
  green: {
    title: "Bokföringen är under kontroll",
    statusClass: "metric green",
    statusLabel: "On track",
    statusCopy: "Aqanto behöver inget från dig just nu",
    closePercent: "94%",
    closeCopy: "1 låg-risk item kvar",
    progress: "94%",
    attention: `
      <article class="attention-card">
        <div>
          <span class="badge soft">Info</span>
          <h3>Inget kräver åtgärd</h3>
          <p>Aqanto fortsätter bevaka underlag, avstämningar och nästa deadline.</p>
        </div>
        <div class="card-actions">
          <button class="secondary">Fråga Aqanto</button>
        </div>
      </article>
    `,
    checklist: `
      <li class="done">Bankhändelser importerade</li>
      <li class="done">Underlag matchade</li>
      <li class="done">Lågriskhändelser bokförda</li>
      <li class="waiting">1 återkommande avgift bevakas</li>
    `,
    nextTitle: "Låt Aqanto fortsätta",
    nextCopy: "Inget kräver manuell åtgärd just nu.",
    message: "Ja, nästan. Maj är 94% redo och inget kräver dig just nu. Jag bevakar sista låg-risk-itemet.",
    activity: `
      <li><strong>Adobe bokförd</strong><span>Känd leverantör · låg risk</span></li>
      <li><strong>Bankavgift matchad</strong><span>Automatisk låg-risk</span></li>
      <li><strong>Deadline bevakas</strong><span>Moms-readiness normal</span></li>
    `
  },
  review: {
    title: "Bokföringen behöver din blick på 2 saker",
    statusClass: "metric attention",
    statusLabel: "Needs review",
    statusCopy: "2 godkännanden innan månaden kan stängas",
    closePercent: "72%",
    closeCopy: "3 blockers kvar",
    progress: "72%",
    attention: `
      <article class="attention-card high">
        <div>
          <span class="badge">Godkännande</span>
          <h3>Ny leverantör: Nordic Hardware</h3>
          <p>Aqanto har inte sett leverantören tidigare och beloppet är över pilotgränsen.</p>
        </div>
        <div class="card-actions">
          <button data-open-exception>Godkänn en gång</button>
          <button class="secondary" data-open-exception>Fråga Aqanto</button>
        </div>
      </article>
      <article class="attention-card">
        <div>
          <span class="badge soft">Underlag</span>
          <h3>Kvitto saknas för kortköp</h3>
          <p>En bankhändelse på 320 kr saknar underlag och blockerar close-checklistan.</p>
        </div>
        <div class="card-actions">
          <button>Ladda upp</button>
          <button class="secondary">Sök igen</button>
        </div>
      </article>
    `,
    checklist: `
      <li class="done">Bankhändelser importerade</li>
      <li class="done">Adobe bokfört som programvara</li>
      <li class="waiting">Ny leverantör väntar på godkännande</li>
      <li class="blocked">2 underlag saknas</li>
    `,
    nextTitle: "Godkänn Nordic Hardware",
    nextCopy: "Då kan Aqanto fortsätta med avstämning och uppdatera close-readiness.",
    message: "Inte riktigt än. Maj är 72% redo. Jag behöver ett godkännande och två underlag innan jag kan stänga tryggt.",
    activity: `
      <li><strong>Adobe matchad</strong><span>Kvitto + bankhändelse · låg risk</span></li>
      <li><strong>Preflight stoppade filing</strong><span>Restricted i pilot</span></li>
      <li><strong>Close uppdaterad</strong><span>Readiness 72%</span></li>
    `
  },
  blocked: {
    title: "Aqanto kan inte fortsätta ännu",
    statusClass: "metric blocked",
    statusLabel: "Blocked",
    statusCopy: "Underlag saknas och en periodåtgärd är stoppad",
    closePercent: "41%",
    closeCopy: "5 blockers kvar",
    progress: "41%",
    attention: `
      <article class="attention-card high">
        <div>
          <span class="badge">Blockerad</span>
          <h3>Perioden är låst</h3>
          <p>Aqanto stoppade en ändring i april eftersom perioden redan är låst.</p>
        </div>
        <div class="card-actions">
          <button class="secondary" data-open-exception>Visa varför</button>
        </div>
      </article>
      <article class="attention-card high">
        <div>
          <span class="badge">Underlag</span>
          <h3>3 underlag saknas</h3>
          <p>Månaden kan inte stängas innan underlagen är uppladdade eller markerade.</p>
        </div>
        <div class="card-actions">
          <button>Ladda upp</button>
        </div>
      </article>
    `,
    checklist: `
      <li class="done">Bankhändelser importerade</li>
      <li class="blocked">Låst period stoppar korrigering</li>
      <li class="blocked">3 underlag saknas</li>
      <li class="waiting">Expertgranskning rekommenderad</li>
    `,
    nextTitle: "Lös blockeraren",
    nextCopy: "Aqanto kan förbereda ett rättelseförslag, men behöver särskilt godkännande för låst period.",
    message: "Nej. Månaden är blockerad eftersom underlag saknas och en ändring gäller låst period. Jag kan visa exakt vad som behöver lösas först.",
    activity: `
      <li><strong>Preflight nekade åtgärd</strong><span>period_locked</span></li>
      <li><strong>Underlag saknas</strong><span>3 händelser</span></li>
      <li><strong>Incident ej skapad</strong><span>Förväntat policy-stopp</span></li>
    `
  }
};

function setState(name) {
  const state = states[name];
  document.querySelectorAll(".state-button").forEach((button) => {
    button.classList.toggle("active", button.dataset.state === name);
  });
  document.querySelector("#page-title").textContent = state.title;
  const statusCard = document.querySelector("#status-card");
  statusCard.className = state.statusClass;
  document.querySelector("#status-label").textContent = state.statusLabel;
  document.querySelector("#status-copy").textContent = state.statusCopy;
  document.querySelector("#close-percent").textContent = state.closePercent;
  document.querySelector("#close-copy").textContent = state.closeCopy;
  document.querySelector("#progress-bar").style.width = state.progress;
  document.querySelector("#attention-list").innerHTML = state.attention;
  document.querySelector("#checklist").innerHTML = state.checklist;
  document.querySelector("#next-step-title").textContent = state.nextTitle;
  document.querySelector("#next-step-copy").textContent = state.nextCopy;
  document.querySelector("#aqanto-message").textContent = state.message;
  document.querySelector("#activity-list").innerHTML = state.activity;
  bindExceptionButtons();
}

document.querySelectorAll(".state-button").forEach((button) => {
  button.addEventListener("click", () => setState(button.dataset.state));
});

function bindExceptionButtons() {
  document.querySelectorAll("[data-open-exception]").forEach((button) => {
    button.addEventListener("click", openExceptionDrawer);
  });
}

function openExceptionDrawer() {
  const drawer = document.querySelector("#exception-drawer");
  drawer.classList.add("open");
  drawer.setAttribute("aria-hidden", "false");
}

function closeExceptionDrawer() {
  const drawer = document.querySelector("#exception-drawer");
  drawer.classList.remove("open");
  drawer.setAttribute("aria-hidden", "true");
}

document.querySelector("#close-exception").addEventListener("click", closeExceptionDrawer);
document.querySelector("#exception-drawer").addEventListener("click", (event) => {
  if (event.target.id === "exception-drawer") {
    closeExceptionDrawer();
  }
});

bindExceptionButtons();
