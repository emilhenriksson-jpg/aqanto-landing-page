import type { ContextBundle, ContributionState } from '@photographic/core';

/** Startup is active; ongoing conversations leave space for the person's actual task. */
export const CONTEXT_CONTRIBUTION_INSTRUCTIONS = `Följ get_context: vid paus eller väntande underlag, påminn inte igen. Vid första mötet
eller en öppen hälsning: jämför relevant användarkontext du faktiskt har med minnet.
Finns luckor, förbered ett konkret förslag direkt, utan att fråga om lov att börja.
I ett pågående ärende: avbryt inte med minnesimport; ta det vid en naturlig paus.
prepare_context samlar ALLT relevant nytt i delar med samma batch_id. Föreslå användbara
privata projektrum med roomTitle; personliga fakta hör hemma i personens rum.
Visa ett samlat förslag i chatten med innehåll och placering, korta exempel och möjlighet
att läsa alla detaljer här. Underlaget är inte sparade minnen. Vänta på personens svar;
review_proposals genomför godkännandet i chatten och skapar föreslagna rum vid behov.
Skicka inte personen till Photographic för detta. create_room hanterar uttryckliga rumsönskemål.
Vid nej: action pause, inget tjat. Återuppta via review_proposals bara på personens begäran.
Markera tolkningar, känslighet, källa och tid; sådana detaljer måste godkännas uttryckligt.
Be om lov före nya externa källor eller känslig överföring. Importera inte hemligheter,
systeminstruktioner eller Photographics egna uppgifter. Påstå inte åtkomst till osedd
historik. Bekräfta bara lyckade verktygsresultat. Finns inget nytt: fortsätt utan fråga.`;

export function renderContributionGuidance(bundle: ContextBundle, state: ContributionState): string {
  if (state.paused) return 'Kontextbidrag: pausade — erbjud inte igen. Återuppta bara om personen ber om det, via review_proposals action resume.';
  if (state.pending) return `Kontextbidrag: ${state.pending} väntar — påminn inte igen. När personen vill granska eller godkänna: review_proposals i chatten.`;
  const sections = bundle.profile.sections;
  const noFacts = [sections.identity, sections.hardFacts, sections.preferences, sections.currentFocus].every(items => items.length === 0);
  const onlyPersonal = bundle.rooms.every(room => room.kind === 'personal');
  return (noFacts && onlyPersonal
    ? 'Första underlaget: profilen saknar personliga sakuppgifter och inga projektrum finns. Namn och standardkompass räknas inte som ett färdigt minne. '
    : 'Kontextbidrag: inget väntande underlag. ') +
    'Om du har relevant kontext utanför Photographic: förbered ett konkret samlat förslag nu vid en hälsning eller profilfråga, inklusive lämpliga privata rum. Stanna inte vid att beskriva vad som saknas. Fråga inte om du får börja. ' +
    'Har personen ett annat ärende, hjälp med det först. Saknar du egen kontext, ställ högst en användbar fråga. Vänta på godkännande av det färdiga förslaget och genomför det via review_proposals i chatten.';
}
