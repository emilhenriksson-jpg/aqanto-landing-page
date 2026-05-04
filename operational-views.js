const viewData = {
  income: {
    title: "Resultatrapport",
    summary: "Jan-maj 2026 · SEK · jämför med samma period föregående år",
    nav: "Rapporter",
    tabs: [],
    metrics: [
      ["Rörelsens intäkter", "37 502 160"],
      ["Period", "Jan-maj 2026"],
      ["Jämförelse", "Föregående år"],
      ["Export", "PDF · Excel"]
    ],
    filters: [
      { id: "compare", label: "Jämför", type: "select", value: "Samma period föregående år", options: ["Ingen jämförelse", "Samma period föregående år", "Föregående period", "Budget"] },
      { id: "from", label: "Från", type: "date", value: "2026-01-01" },
      { id: "to", label: "Till", type: "date", value: "2026-05-31" },
      { id: "budget", label: "Jämför mot budget", type: "select", value: "Ingen budget vald", options: ["Ingen budget vald", "Budget 2026", "Prognos 2026"] },
      { id: "currency", label: "Valuta", type: "segment", value: "SEK", options: ["SEK", "TSEK"] },
      { id: "decimals", label: "Visa decimaler", type: "checkbox", value: false },
      { id: "level", label: "Kontonivå", type: "select", value: "Visa konton", options: ["Visa konton", "Endast rubriker", "Endast totalsummor"] }
    ],
    exportOptions: [
      { label: "PDF", availability: "available" },
      { label: "Excel", availability: "available" },
      { label: "CSV", availability: "restricted", reason: "CSV aktiveras efter exportpolicy-review" }
    ],
    chips: ["Period: Jan-maj 2026", "Valuta: SEK", "Jämför: föregående år"],
    savedViews: ["YTD med jämförelse", "Endast totalsummor", "Budgetavvikelse"],
    columns: ["Konto", "Namn", "Jan - Maj 2026", "Jämförelse", "Evidence"],
    rows: [
      { kind: "section", cells: ["Nettoomsättning", "", "Jan - Maj 2026", "Föregående år", ""] },
      { cells: ["3000", "Försäljning inom Sverige", "-406 669", "-392 400", "12 underlag"] },
      { cells: ["3001", "Försäljning inom Sverige, 25 % moms", "14 266 991", "13 881 420", "186 underlag"] },
      { cells: ["3002", "Försäljning inom Sverige, 12 % moms", "382 604", "355 901", "24 underlag"] },
      { cells: ["3003", "Försäljning inom Sverige, 6 % moms", "15 029 666", "14 502 120", "91 underlag"] },
      { cells: ["3005", "Medlemsavgifter, 25 % moms", "7 581 853", "6 992 050", "74 underlag"] },
      { cells: ["3740", "Öres- och kronutjämning", "15", "18", "Automatisk"] },
      { kind: "total", cells: ["Summa nettoomsättning", "", "36 854 460", "35 339 109", ""] },
      { kind: "section", cells: ["Aktiverat arbete för egen räkning", "", "Jan - Maj 2026", "Föregående år", ""] },
      { cells: ["3870", "Aktiverat arbete (personal)", "586 790", "540 010", "8 underlag"] },
      { kind: "total", cells: ["Summa aktiverat arbete för egen räkning", "", "586 790", "540 010", ""] },
      { kind: "section", cells: ["Övriga rörelseintäkter", "", "Jan - Maj 2026", "Föregående år", ""] },
      { cells: ["3960", "Valutakursvinster på fordringar och skulder", "7 155", "8 401", "Matchad"] },
      { cells: ["3988", "Erhållna bidrag och ersättningar för personal", "53 755", "0", "2 underlag"] },
      { kind: "total", cells: ["Summa rörelsens intäkter", "", "37 502 160", "35 887 520", ""] }
    ]
  },
  balance: {
    title: "Balansrapport",
    summary: "Balans per 2026-05-04 · period från 2026-01-01 · SEK",
    nav: "Rapporter",
    tabs: [],
    metrics: [
      ["Tillgångar", "31 228 450"],
      ["Periodrörelse", "1 112 820"],
      ["Vy", "Ingående · Period · Utgående"],
      ["Export", "PDF · Excel"]
    ],
    filters: [
      { id: "from", label: "Från", type: "date", value: "2026-01-01" },
      { id: "to", label: "Till", type: "date", value: "2026-05-04" },
      { id: "currency", label: "Valuta", type: "segment", value: "SEK", options: ["SEK", "TSEK"] },
      { id: "decimals", label: "Visa decimaler", type: "checkbox", value: false },
      { id: "columns", label: "Kolumner", type: "select", value: "Ingående, period, utgående", options: ["Ingående, period, utgående", "Endast utgående", "Period och utgående"] }
    ],
    exportOptions: [
      { label: "PDF", availability: "available" },
      { label: "Excel", availability: "available" },
      { label: "CSV", availability: "restricted", reason: "Formell rapport exporteras som PDF/Excel i pilot" }
    ],
    chips: ["Balansdatum: 2026-05-04", "Från: 2026-01-01", "Valuta: SEK"],
    savedViews: ["Balans per idag", "Månadsstängning", "Endast utgående"],
    columns: ["Konto", "Namn", "Ingående", "Period", "Utgående", "Evidence"],
    rows: [
      { kind: "subsection", cells: ["Anläggningstillgångar", "", "", "", "", ""] },
      { kind: "section", cells: ["Immateriella anläggningstillgångar", "", "Ingående", "Period", "Utgående", ""] },
      { cells: ["1019", "Ackumulerade avskrivningar på balanserade utgifter", "-17 289 130", "-1 870 669", "-19 159 799", "Avskrivningsregel"] },
      { cells: ["1050", "Varumärken", "0", "200 000", "200 000", "Verifikat"] },
      { cells: ["1059", "Ackumulerade avskrivningar på varumärken", "0", "-10 000", "-10 000", "Avskrivningsregel"] },
      { cells: ["1082", "Pågående projekt och förskott (IT 2017)", "2 569 386", "0", "2 569 386", "Projekt"] },
      { cells: ["1087", "Pågående projekt och förskott (IT)", "17 910 446", "1 976 590", "19 887 037", "Projekt"] },
      { kind: "total", cells: ["Summa immateriella anläggningstillgångar", "", "12 168 113", "295 921", "12 464 034", ""] },
      { kind: "section", cells: ["Materiella anläggningstillgångar", "", "Ingående", "Period", "Utgående", ""] },
      { cells: ["1200", "Maskiner och Inventarier", "244 895", "0", "244 895", "Register"] },
      { cells: ["1229", "Ackumulerade avskrivningar på inventarier", "-222 660", "-17 733", "-240 393", "Avskrivningsregel"] },
      { cells: ["1240", "Bilar och andra transportmedel", "95 000", "0", "95 000", "Register"] }
    ]
  },
  suppliers: {
    title: "Leverantörsreskontra",
    summary: "308 obetalda fakturor · 2 under betalning · 12 förfaller inom 7 dagar",
    nav: "Leverantörsfakturor",
    tabs: [
      ["Alla", "323"],
      ["Obetalda", "308"],
      ["Obetalda (Koncern)", "41"],
      ["Förfallna", "12"],
      ["Kreditfakturor", "4"]
    ],
    metrics: [
      ["Återstående", "4 821 904 SEK"],
      ["Förfallet", "182 450 SEK"],
      ["Under betalning", "2"],
      ["Kräver attest", "15"]
    ],
    filters: [
      { id: "supplier", label: "Leverantör", type: "select", value: "Alla leverantörer", options: ["Alla leverantörer", "Budbee/Instabox", "Instabee Group AB", "Dcs Aps"] },
      { id: "due", label: "Förfall", type: "select", value: "Alla datum", options: ["Alla datum", "Förfaller inom 7 dagar", "Förfallna", "Denna månad"] },
      { id: "amount", label: "Belopp", type: "select", value: "Alla belopp", options: ["Alla belopp", "Över 10 000 SEK", "Över 50 000 SEK"] },
      { id: "owner", label: "Ansvarig", type: "select", value: "Alla ansvariga", options: ["Alla ansvariga", "Aqanto", "Emil", "Extern redovisning"] }
    ],
    exportOptions: [
      { label: "PDF", availability: "available" },
      { label: "Excel", availability: "available" },
      { label: "CSV", availability: "available" }
    ],
    chips: ["Status: Obetalda", "Förfall: alla datum", "Sortering: fakturadatum"],
    savedViews: ["Förfaller inom 7 dagar", "Största belopp", "Under betalning"],
    columns: ["Nr", "Leverantör", "Fakturadatum", "Bokföringsdatum", "Förfallodatum", "Betaldatum", "Exkl. moms", "Inkl. moms", "Återstående", "Evidence"],
    rows: [
      { cells: ["SE03144444", "Budbee/Instabox2", "2026-05-03", "2026-05-03", "2026-05-13", "", "3 185,75 SEK", "3 982,20 SEK", "3 982,20 SEK", "Faktura"] },
      { cells: ["SE02010816", "Instabee Group AB", "2026-05-03", "2026-05-03", "2026-05-13", "", "3 714,70 SEK", "4 643,38 SEK", "4 643,38 SEK", "Faktura"] },
      { cells: ["SE03144445", "Budbee/Instabox2", "2026-05-03", "2026-05-03", "2026-05-13", "", "15 217,96 SEK", "19 022,45 SEK", "19 022,45 SEK", "Faktura"] },
      { cells: ["5338592", "Dcs Aps", "2026-05-01", "2026-05-01", "2026-05-06", "Under betalning", "456,91 SEK", "456,91 SEK", "456,91 SEK", "Policy + bankfil"] },
      { cells: ["13846475", "Cs-online.se AB", "2026-05-01", "2026-05-01", "2026-05-09", "", "410,84 SEK", "513,55 SEK", "513,55 SEK", "Faktura"] },
      { cells: ["CI000009106", "Bonnierförlagen Aktiebolag", "2026-05-01", "2026-05-01", "2026-05-31", "", "31 683,01 SEK", "33 584,00 SEK", "33 584,00 SEK", "Faktura"] },
      { cells: ["35427", "Rule Communication - Nordic AB", "2026-05-01", "2026-05-01", "2026-05-31", "", "50 271,15 SEK", "62 839,00 SEK", "62 839,00 SEK", "Faktura"] }
    ]
  },
  exceptions: {
    title: "Human Exceptions",
    summary: "2 öppna beslut · 1 saknat underlag · månadsstängning väntar",
    nav: "Arbetsköer",
    tabs: [
      ["Alla", "8"],
      ["Öppna", "2"],
      ["Godkännande", "1"],
      ["Saknat underlag", "1"],
      ["Blockerade", "1"]
    ],
    metrics: [
      ["Öppna", "2"],
      ["Högsta risk", "Medium"],
      ["Påverkar close", "2"],
      ["Nästa deadline", "2026-05-10"]
    ],
    filters: [
      { id: "type", label: "Typ", type: "select", value: "Alla typer", options: ["Alla typer", "Godkännande", "Saknat underlag", "Policy block", "Anomali"] },
      { id: "risk", label: "Risk", type: "select", value: "Alla risker", options: ["Alla risker", "Low", "Medium", "High", "Critical"] },
      { id: "agent", label: "Agent", type: "select", value: "Alla agenter", options: ["Alla agenter", "Classification", "Reconciliation", "Controller", "Compliance"] },
      { id: "deadline", label: "Deadline", type: "select", value: "Alla deadlines", options: ["Alla deadlines", "Idag", "Denna vecka", "Blockerar close"] }
    ],
    exportOptions: [
      { label: "PDF", availability: "available" },
      { label: "Excel", availability: "available" },
      { label: "CSV", availability: "restricted", reason: "Exception-export kräver reviewer-scope" }
    ],
    chips: ["Status: öppna", "Påverkar close", "Sortering: deadline"],
    savedViews: ["Blockerar close", "Medium+ risk", "Mina beslut"],
    columns: ["ID", "Ärende", "Typ", "Risk", "Confidence", "Deadline", "Agent", "Nästa åtgärd", "Evidence"],
    rows: [
      { cells: ["HE-1042", "Ny leverantör: Nordic Hardware", "Godkännande", "Medium", "74%", "2026-05-10", "Controller", "Godkänn en gång", "2 bevis + policy"] },
      { cells: ["HE-1043", "Kvitto saknas för kortköp", "Saknat underlag", "Medium", "52%", "2026-05-10", "Reconciliation", "Ladda upp underlag", "Bankhändelse"] },
      { kind: "total", cells: ["Close blockerande exceptions", "", "", "", "", "", "", "2", ""] }
    ]
  },
  activity: {
    title: "Activity & Audit Stream",
    summary: "84 händelser i maj · 71 autonoma · 13 granskade eller stoppade",
    nav: "Arbetsköer",
    tabs: [
      ["Alla", "84"],
      ["Autonoma", "71"],
      ["Frågade människa", "8"],
      ["Blockerade", "3"],
      ["Korrigerade", "2"]
    ],
    metrics: [
      ["Autonomy rate", "84%"],
      ["Blockerade", "3"],
      ["Audit receipts", "84"],
      ["Raw prompt lagrad", "Nej"]
    ],
    filters: [
      { id: "event_type", label: "Händelse", type: "select", value: "Alla händelser", options: ["Alla händelser", "Extracted", "Classified", "Matched", "Posted", "Blocked", "Asked human"] },
      { id: "agent", label: "Agent", type: "select", value: "Alla agenter", options: ["Alla agenter", "Intake", "Classification", "Reconciliation", "Controller", "Compliance"] },
      { id: "risk", label: "Risk", type: "select", value: "Alla risker", options: ["Alla risker", "Low", "Medium", "High", "Critical"] },
      { id: "date", label: "Datum", type: "date", value: "2026-05-04" }
    ],
    exportOptions: [
      { label: "PDF", availability: "available" },
      { label: "Excel", availability: "available" },
      { label: "CSV", availability: "restricted", reason: "Audit-stream CSV kräver särskild exportpolicy" }
    ],
    chips: ["Period: maj 2026", "Audit: komplett", "Tenant-scope: BuyersClub"],
    savedViews: ["Blockerade händelser", "Autonoma poster", "Compliance-spår"],
    columns: ["Tid", "Händelse", "Objekt", "Status", "Agent", "Risk", "Policy", "Evidence", "Audit"],
    rows: [
      { cells: ["16:42", "Preflight stoppade filing", "Momsrapport", "Restricted", "Compliance", "High", "external_filing_submit", "Regelversion", "Receipt"] },
      { cells: ["16:31", "Leverantörsfaktura matchad", "SE03144444", "Matched", "Reconciliation", "Low", "delegated_read", "Faktura + bank", "Receipt"] },
      { cells: ["16:20", "Ny leverantör flaggad", "Nordic Hardware", "Asked human", "Controller", "Medium", "new_counterparty", "2 bevis", "Receipt"] },
      { cells: ["16:02", "Adobe bokförd i ledger stub", "bank_tx_adobe_2026_05", "Posted draft", "Classification", "Low", "low_risk_execute", "Kvitto + bank", "Receipt"] }
    ]
  }
};

let currentView = "income";
const hiddenColumnsByView = {};
const savedViewByView = {};

Object.values(viewData).forEach((view) => {
  view.filters.forEach((field) => {
    field.defaultValue = field.value;
  });
});

function renderView(name, options = {}) {
  currentView = name;
  const view = viewData[name];
  if (!view) {
    return;
  }
  applyUrlState(name);
  if (options.syncUrl !== false) {
    syncUrlState();
  }
  document.querySelectorAll(".nav-button").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === name);
  });
  document.querySelector("#view-title").textContent = view.title;
  document.querySelector("#view-summary").textContent = view.summary;
  document.querySelector("#view-context").textContent = view.nav;
  renderTabs(view);
  renderExportActions(view);
  renderFilters(view);
  renderChips(view);
  renderSavedViews(view);
  renderMetrics(view);
  renderColumnMenu(view);
  renderTable(view);
  openDrawerFor(view.rows.find((row) => !row.kind)?.cells || []);
}

function renderTabs(view) {
  const tabs = document.querySelector("#view-tabs");
  if (!view.tabs.length) {
    tabs.innerHTML = "";
    return;
  }
  tabs.innerHTML = view.tabs.map(([label, count], index) => (
    `<button class="tab-button ${index === Math.min(1, view.tabs.length - 1) ? "active" : ""}" type="button">${label} <span class="count">${count}</span></button>`
  )).join("");
}

function renderExportActions(view) {
  const actions = document.querySelector("#export-actions");
  const exportButtons = (view.exportOptions || []).map((option) => {
    const disabled = option.availability !== "available";
    const title = option.reason ? ` title="${option.reason}"` : "";
    return `<button class="icon-action" type="button" data-export-format="${option.label}" ${disabled ? "disabled" : ""}${title}>${option.label}</button>`;
  }).join("");
  actions.innerHTML = `${exportButtons}<button id="open-drawer" class="ghost-action" type="button">Evidence</button>`;
  document.querySelectorAll("[data-export-format]").forEach((button) => {
    button.addEventListener("click", () => openExportReceipt(button.dataset.exportFormat));
  });
  document.querySelector("#open-drawer").addEventListener("click", () => {
    document.querySelector("#drawer").classList.add("open");
    document.querySelector("#drawer").setAttribute("aria-hidden", "false");
  });
}

function openExportReceipt(format) {
  const view = viewData[currentView];
  document.querySelector("#drawer-title").textContent = `${format}-export`;
  document.querySelector("#drawer-copy").textContent = "Exporten skapar ett audit receipt med exakt vy, period, filter, sortering och actor-scope. Rå privat chatt och orelaterad personlig data följer inte med.";
  document.querySelector("#drawer-list").innerHTML = [
    `<li><strong>Vy</strong><br>${view.title}</li>`,
    `<li><strong>Aktiva filter</strong><br>${view.chips.join(" · ")}</li>`,
    `<li><strong>Behörighet</strong><br>Customer Admin eller striktare enligt export policy</li>`,
    `<li><strong>Audit</strong><br>Export receipt krävs och sparas company-scoped.</li>`
  ].join("");
  document.querySelector("#drawer").classList.add("open");
  document.querySelector("#drawer").setAttribute("aria-hidden", "false");
}

function renderFilters(view) {
  document.querySelector("#filter-grid").innerHTML = view.filters.map((field) => {
    if (field.type === "select") {
      const options = field.options.map((option) => `<option ${option === field.value ? "selected" : ""}>${option}</option>`).join("");
      return `<div class="filter-field"><label for="${field.id}">${field.label}</label><select id="${field.id}">${options}</select></div>`;
    }
    if (field.type === "date") {
      return `<div class="filter-field"><label for="${field.id}">${field.label}</label><input id="${field.id}" type="date" value="${field.value}"></div>`;
    }
    if (field.type === "segment") {
      return `<div class="filter-field"><span class="field-label">${field.label}</span><div class="segmented">${field.options.map((option) => `<button class="segment ${option === field.value ? "active" : ""}" type="button">${option}</button>`).join("")}</div></div>`;
    }
    return `<label class="checkbox-line"><input id="${field.id}" type="checkbox" ${field.value ? "checked" : ""}>${field.label}</label>`;
  }).join("");
  view.filters.forEach((field) => {
    const control = document.querySelector(`#${field.id}`);
    if (control) {
      control.addEventListener("change", () => {
        field.value = field.type === "checkbox" ? control.checked : control.value;
        renderChips(view);
        syncUrlState();
      });
    }
  });
  document.querySelectorAll(".segment").forEach((button) => {
    button.addEventListener("click", () => {
      const wrapper = button.closest(".filter-field");
      const label = wrapper.querySelector(".field-label")?.textContent;
      const field = view.filters.find((item) => item.label === label);
      if (!field) return;
      field.value = button.textContent;
      wrapper.querySelectorAll(".segment").forEach((segment) => segment.classList.remove("active"));
      button.classList.add("active");
      renderChips(view);
      syncUrlState();
    });
  });
}

function renderChips(view) {
  const dynamicChips = view.filters
    .filter((field) => field.type !== "checkbox" || field.value)
    .map((field) => `<span class="chip">${field.label}: ${field.value === true ? "Ja" : field.value}</span>`);
  document.querySelector("#chips-row").innerHTML = [
    ...dynamicChips,
    `<button id="clear-filters" class="ghost-action" type="button">Rensa filter</button>`
  ].join("");
  document.querySelector("#clear-filters").addEventListener("click", () => {
    view.filters.forEach((field) => {
      field.value = field.defaultValue;
    });
    savedViewByView[currentView] = null;
    syncUrlState();
    renderView(currentView, { syncUrl: false });
  });
}

function renderSavedViews(view) {
  const savedViews = view.savedViews || [];
  const activeSavedView = savedViewByView[currentView] || savedViews[0];
  document.querySelector("#saved-views").innerHTML = [
    `<span class="saved-views-label">Sparade vyer</span>`,
    ...savedViews.map((label) => `<button class="saved-view-button ${label === activeSavedView ? "active" : ""}" type="button" data-saved-view="${label}">${label}</button>`),
    `<button class="saved-view-button" type="button">Spara aktuell vy</button>`
  ].join("");
  document.querySelectorAll("[data-saved-view]").forEach((button) => {
    button.addEventListener("click", () => {
      savedViewByView[currentView] = button.dataset.savedView;
      renderSavedViews(view);
      syncUrlState();
    });
  });
}

function renderMetrics(view) {
  document.querySelector("#summary-strip").innerHTML = view.metrics.map(([label, value]) => (
    `<article class="summary-card"><span>${label}</span><strong>${value}</strong></article>`
  )).join("");
}

function renderTable(view) {
  const hidden = hiddenColumnsByView[currentView] || new Set();
  const visibleColumns = view.columns.map((column, index) => ({ column, index })).filter((item) => !hidden.has(item.index));
  const head = visibleColumns.map(({ column, index }) => `<th class="${index > 1 ? "amount" : ""}">${column} ↕</th>`).join("");
  const body = view.rows.map((row) => {
    const className = row.kind ? `${row.kind}-row` : "";
    const cells = visibleColumns.map(({ index }) => {
      const cell = row.cells[index] || "";
      const amountClass = index > 1 && /^-?[0-9]/.test(cell) ? "amount" : "";
      if (!row.kind && index === 1) {
        return `<td><button class="link-cell" type="button" data-row="${row.cells[0]}">${cell}</button></td>`;
      }
      if (!row.kind && currentView === "suppliers" && index === 4 && ["2026-05-06", "2026-05-09"].includes(cell)) {
        return `<td><span class="due-badge">${cell}</span></td>`;
      }
      if (!row.kind && currentView === "suppliers" && index === 5 && cell) {
        return `<td><span class="status-text">${cell}</span></td>`;
      }
      return `<td class="${amountClass}">${cell}</td>`;
    }).join("");
    return `<tr class="${className}">${cells}</tr>`;
  }).join("");
  document.querySelector("#data-table").innerHTML = `<thead><tr>${head}</tr></thead><tbody>${body}</tbody>`;
  document.querySelectorAll(".link-cell").forEach((button) => {
    button.addEventListener("click", () => {
      openDrawerFor(findRow(button.dataset.row));
      document.querySelector("#drawer").classList.add("open");
      document.querySelector("#drawer").setAttribute("aria-hidden", "false");
    });
  });
}

function renderColumnMenu(view) {
  const hidden = hiddenColumnsByView[currentView] || new Set();
  document.querySelector("#column-menu-panel").innerHTML = view.columns.map((column, index) => (
    `<label class="column-toggle"><input type="checkbox" data-column-index="${index}" ${hidden.has(index) ? "" : "checked"}>${column}</label>`
  )).join("");
  document.querySelectorAll("[data-column-index]").forEach((input) => {
    input.addEventListener("change", () => {
      const nextHidden = hiddenColumnsByView[currentView] || new Set();
      const index = Number(input.dataset.columnIndex);
      if (input.checked) {
        nextHidden.delete(index);
      } else {
        nextHidden.add(index);
      }
      hiddenColumnsByView[currentView] = nextHidden;
      renderTable(viewData[currentView]);
      syncUrlState();
    });
  });
}

function applyUrlState(viewName) {
  const params = new URLSearchParams(window.location.search);
  const view = viewData[viewName];
  view.filters.forEach((field) => {
    const value = params.get(`f_${field.id}`);
    if (value === null) return;
    field.value = field.type === "checkbox" ? value === "true" : value;
  });
  const savedView = params.get("saved");
  if (savedView) {
    savedViewByView[viewName] = savedView;
  }
  const hidden = params.get("hide");
  hiddenColumnsByView[viewName] = new Set(
    hidden ? hidden.split(",").filter(Boolean).map((index) => Number(index)) : Array.from(hiddenColumnsByView[viewName] || [])
  );
}

function syncUrlState() {
  const view = viewData[currentView];
  const url = new URL(window.location.href);
  url.search = "";
  url.searchParams.set("view", currentView);
  view.filters.forEach((field) => {
    if (field.value !== field.defaultValue) {
      url.searchParams.set(`f_${field.id}`, String(field.value));
    }
  });
  if (savedViewByView[currentView]) {
    url.searchParams.set("saved", savedViewByView[currentView]);
  }
  const hidden = Array.from(hiddenColumnsByView[currentView] || []);
  if (hidden.length) {
    url.searchParams.set("hide", hidden.join(","));
  }
  window.history.replaceState({ view: currentView }, "", url);
}

function findRow(id) {
  const view = viewData[currentView];
  return view.rows.find((row) => row.cells && row.cells[0] === id)?.cells || [];
}

function openDrawerFor(cells) {
  const title = cells[1] || viewData[currentView].title;
  document.querySelector("#drawer-title").textContent = title;
  document.querySelector("#drawer-copy").textContent = "Aqanto visar alltid var raden kommer ifrån, vilka filter som påverkade urvalet och vilka bevis eller audit-händelser som stöder siffran.";
  document.querySelector("#drawer-list").innerHTML = [
    `<li><strong>Objekt</strong><br>${cells[0] || "Rapportvy"}</li>`,
    `<li><strong>Evidence</strong><br>${cells[cells.length - 1] || "Sammanställd från ledger och audit trail"}</li>`,
    `<li><strong>Policy</strong><br>Rollbaserad åtkomst, tenant-scope och exportkontroll krävs.</li>`
  ].join("");
}

document.querySelectorAll(".nav-button").forEach((button) => {
  if (button.dataset.view) {
    button.addEventListener("click", () => renderView(button.dataset.view));
  }
});

document.querySelector("#close-drawer").addEventListener("click", () => {
  document.querySelector("#drawer").classList.remove("open");
  document.querySelector("#drawer").setAttribute("aria-hidden", "true");
});

document.querySelector("#drawer").addEventListener("click", (event) => {
  if (event.target.id === "drawer") {
    document.querySelector("#close-drawer").click();
  }
});

document.querySelector("#column-menu-button").addEventListener("click", () => {
  document.querySelector("#column-menu").classList.toggle("open");
});

document.addEventListener("click", (event) => {
  const menu = document.querySelector("#column-menu");
  if (!menu.contains(event.target)) {
    menu.classList.remove("open");
  }
});

window.addEventListener("popstate", (event) => {
  const view = event.state?.view || new URLSearchParams(window.location.search).get("view") || "income";
  renderView(viewData[view] ? view : "income", { syncUrl: false });
});

const initialView = new URLSearchParams(window.location.search).get("view");
renderView(viewData[initialView] ? initialView : currentView, { syncUrl: false });
