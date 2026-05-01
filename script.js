const salaryInput = document.querySelector("#salaryInput");
const rolesInput = document.querySelector("#rolesInput");
const salaryValue = document.querySelector("#salaryValue");
const rolesValue = document.querySelector("#rolesValue");
const monthlySaving = document.querySelector("#monthlySaving");
const yearlySaving = document.querySelector("#yearlySaving");

const formatter = new Intl.NumberFormat("sv-SE");

function money(value) {
  return `${formatter.format(value)} kr`;
}

function updateCalculator() {
  const salary = Number(salaryInput.value);
  const roles = Number(rolesInput.value);
  const aqantoPrice = 10000;
  const monthly = Math.max(0, salary * roles - aqantoPrice);
  const yearly = monthly * 12;

  salaryValue.textContent = money(salary);
  rolesValue.textContent = String(roles);
  monthlySaving.textContent = `${money(monthly)}/mån`;
  yearlySaving.textContent = `Det motsvarar ${money(yearly)} per år före andra effektvinster.`;
}

salaryInput.addEventListener("input", updateCalculator);
rolesInput.addEventListener("input", updateCalculator);

updateCalculator();
