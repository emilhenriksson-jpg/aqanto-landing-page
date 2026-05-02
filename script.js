const aqantoMonthlyBaselinePrice = 10000;
const employerCostMultiplier = 1.45;

function getNumber(id, fallback = 0) {
  const element = document.querySelector(`#${id}`);
  return element ? Number(element.value) : fallback;
}

function setText(id, value) {
  const element = document.querySelector(`#${id}`);
  if (element) {
    element.textContent = value;
  }
}

function formatSek(value) {
  return new Intl.NumberFormat("sv-SE", {
    maximumFractionDigits: 0,
  }).format(value);
}

function formatPerItem(value) {
  return `${new Intl.NumberFormat("sv-SE", {
    maximumFractionDigits: 0,
  }).format(value)} kr/post`;
}

function updateSalaryCalculator() {
  const salary = getNumber("salaryInput", 45000);
  const roles = getNumber("rolesInput", 1);
  const internalMonthlyCost = salary * roles * employerCostMultiplier;
  const monthlySaving = Math.max(0, internalMonthlyCost - aqantoMonthlyBaselinePrice);

  setText("salaryValue", `${formatSek(salary)} kr`);
  setText("rolesValue", formatSek(roles));
  setText("monthlySaving", `${formatSek(monthlySaving)} kr/mån`);
  setText("yearlySaving", `${formatSek(monthlySaving * 12)} kr`);
}

function updateSupplierCalculator() {
  const currentCost = getNumber("currentCostInput", 25000);
  const volume = Math.max(1, getNumber("volumeInput", 350));
  const saving = Math.max(0, currentCost - aqantoMonthlyBaselinePrice);
  const costPerItem = currentCost / volume;
  let decision = "Bra kandidat";

  if (currentCost < aqantoMonthlyBaselinePrice * 1.2) {
    decision = "Svag besparing";
  } else if (costPerItem > 120) {
    decision = "Stark kandidat";
  }

  setText("currentCostValue", `${formatSek(currentCost)} kr`);
  setText("volumeValue", formatSek(volume));
  setText("supplierSaving", `${formatSek(saving)} kr/mån`);
  setText("supplierInsight", formatPerItem(costPerItem));
  setText("supplierDecision", decision);
}

function updateDemoOutput() {
  const companyName = document.querySelector("#companyName")?.value || "Bolaget";
  const monthlyCost = getNumber("monthlyCost", 0);
  const monthlyVolume = Math.max(1, getNumber("monthlyVolume", 1));
  const accountingSystem = document.querySelector("#accountingSystem")?.value || "okänt system";
  const saving = Math.max(0, monthlyCost - aqantoMonthlyBaselinePrice);
  const costPerItem = monthlyCost / monthlyVolume;
  const output = document.querySelector("#demoOutput");

  if (!output) {
    return;
  }

  output.innerHTML = `
    <span class="result-kicker">Lokalt underlag</span>
    <strong>${companyName}: ${formatSek(saving)} kr/mån möjlig differens</strong>
    <p>${companyName} använder ${accountingSystem}, har cirka ${formatSek(monthlyVolume)} poster per månad och betalar ungefär ${formatPerItem(costPerItem)}. Nästa steg är att kontrollera materialmix, integrationsläge och vilka poster som kräver mänsklig review.</p>
  `;
}

["salaryInput", "rolesInput"].forEach((id) => {
  document.querySelector(`#${id}`)?.addEventListener("input", updateSalaryCalculator);
});

["currentCostInput", "volumeInput"].forEach((id) => {
  document.querySelector(`#${id}`)?.addEventListener("input", updateSupplierCalculator);
});

["companyName", "monthlyCost", "monthlyVolume", "accountingSystem"].forEach((id) => {
  document.querySelector(`#${id}`)?.addEventListener("input", updateDemoOutput);
});

document.querySelector("#demoRequestForm")?.addEventListener("submit", (event) => {
  event.preventDefault();
  updateDemoOutput();
});

updateSalaryCalculator();
updateSupplierCalculator();
updateDemoOutput();
