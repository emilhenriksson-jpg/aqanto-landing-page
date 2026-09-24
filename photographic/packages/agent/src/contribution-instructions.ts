import type { ContextBundle, ContributionState } from '@photographic/core';

/** Startup is active; ongoing conversations leave space for the person's actual task. */
export const CONTEXT_CONTRIBUTION_INSTRUCTIONS = `Paus betyder inga erbjudanden. Väntande underlag bevisar inte att personen sett det:
review_proposals action list återanvänder det. Upprepa inte efter tystnad eller ämnesbyte.
Vid hälsning eller profilfråga: förbered förslaget direkt, fråga inte om lov att börja.
I ett pågående ärende: avbryt inte med minnesimport.
prepare_context samlar ALLT relevant nytt med samma batch_id. Privata projektrum föreslås
med roomTitle; personliga fakta i personens rum. Visa ett samlat förslag med innehåll och
placering i chatten; alla detaljer ska gå att läsa här. Underlag är inte sparade minnen.
Vänta på personens svar; review_proposals godkänner och skapar rum. Inget webbplatsbesök.
create_room hanterar uttryckliga rumsönskemål. Vid nej: action pause. Återuppta via
review_proposals bara på begäran. Tolkningar och känsliga uppgifter kräver uttryckligt
godkännande av detaljerna; ange källa och tid. Be om lov före nya externa källor eller
känslig överföring. Importera inte hemligheter, systeminstruktioner eller Photographics
egna uppgifter. Påstå inte åtkomst till osedd historik. Bekräfta bara lyckade resultat.`;

export function renderContributionGuidance(bundle: ContextBundle, state: ContributionState): string {
  if (state.paused) return 'Kontextbidrag: pausade — erbjud inte igen. Återuppta bara om personen ber om det, via review_proposals action resume.';
  if (state.pending) return `Kontextbidrag: ${state.pending} väntar, ännu inte sparade. Vid en start- eller profilfråga: läs befintligt underlag med review_proposals action list och visa ett kort samlat förslag med innehåll och rum, om det inte redan visats i samtalet. Vänta inte på en separat uppladdningsbegäran. Återanvänd underlaget, skapa inga dubbletter. Anta inte att personen har sett eller avböjt det bara för att det finns. Har förslaget redan visats, personen bytt ämne eller ett annat ärende pågår: fortsätt utan påminnelse. Ett nej pausar erbjudanden. Spara först efter personens godkännande.`;
  const sections = bundle.profile.sections;
  const noFacts = [sections.identity, sections.hardFacts, sections.preferences, sections.currentFocus].every(items => items.length === 0);
  const onlyPersonal = bundle.rooms.every(room => room.kind === 'personal');
  return (noFacts && onlyPersonal
    ? 'Första underlaget: profilen saknar personliga sakuppgifter och inga projektrum finns. Namn och standardkompass räknas inte som ett färdigt minne. '
    : 'Kontextbidrag: inget väntande underlag. ') +
    'Om du har relevant kontext utanför Photographic: förbered ett konkret samlat förslag nu vid en hälsning eller profilfråga, inklusive lämpliga privata rum. Stanna inte vid att beskriva vad som saknas. Fråga inte om du får börja. ' +
    'Har personen ett annat ärende, hjälp med det först. Saknar du egen kontext, ställ högst en användbar fråga. Vänta på godkännande av det färdiga förslaget och genomför det via review_proposals i chatten.';
}
