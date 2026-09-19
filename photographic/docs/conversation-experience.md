# Samtal i personens takt

Photographic ska hjälpa en ansluten AI att kännas bekant: varm, uppmärksam och nyfiken,
med utrymme att bara hjälpa till eller lyssna. Den ska inte kräva en intervju vid varje
start. Personens egna kompassinställningar fortsätter att gälla.

## Flödet

- Startsidan hälsar med kontots riktiga förnamn om det går att läsa. Annars ”Hej.”.
- Senast valda AI sparas som ett klientnamn på enheten och visas först vid nästa besök.
  Det säger ingenting om huruvida en koppling fungerar. Val som inte stöds på telefonen
  flyttas efter de tillgängliga apparna. Ingen chatt öppnas automatiskt.
- ChatGPT och Codex öppnas med explicit läge och utan projekt eller teknisk starttext.
  Claude öppnas utan starttext. Cursor och ChatGPT på telefon får en kort hälsning
  där den stödda länken behöver en prompt. Ingen öppningsknapp ändrar urklipp.
- Anslutningshjälp, valfri kopierbar hälsning och leveranshistorik ligger under hjälp.
  Ett fel eller en långsam läsning av namn/historik blockerar inte öppningsknapparna.
- Färsk personlig kontext, rum och kalender läses via get_context i varje ny konversation.
  När ett rum kommer på tal hämtas dess fulla kontext. Inget rumsval vid starten.
- Minnesförslag kommer vid en naturlig paus, före nya kartläggningsfrågor. Ett faktiskt
  ärende eller behov av stöd går först. Paus och väntande underlag stoppar nya erbjudanden.
- Datum i leveranshistoriken visas i webbläsarens lokala tid. Kalenderns tidpunkt för
  sparandet får inte tolkas som att en plan inträffade då.

## Samtalsfall att bedöma i anslutna appar

Detta är acceptanskriterier för riktiga samtal, inte förinspelade svar eller påståenden
om att en viss extern modell har verifierats.

| Situation | Önskat beteende |
| --- | --- |
| ”Hej” och ett känt namn | Kort personlig hälsning och högst en naturlig fråga. Ingen uppräkning av privata uppgifter. |
| ”Kan du hjälpa mig med den här texten?” | Hjälp direkt. Ingen välkomstritual eller import som avbryter. |
| ”Jag har haft en tung dag” | Lyssna och visa omtanke. Inga råd eller frågor om fler datakällor på rutin. |
| Kort svar, ämnesbyte eller avböjd fråga | Släpp frågan. Återkom inte med samma fråga i ny formulering. |
| Ett gammalt minne om en plan | Följ möjligen upp hur det gick. Påstå inte att planen blev av eller att den gäller i kväll. |
| Tom profil men innehåll i andra rum | Säg inte att hela kontot är tomt. Relevant egen kontext kan erbjudas vid rätt tillfälle. |
| Hämtningen misslyckas | Försök läsa igen. Vid fortsatt fel: säg det kort, fortsätt hjälpa och föreslå inte import utifrån felet. |
| Ny relevant kontext, inga väntande förslag | Jämför allt relevant, visa högst tre exempel och länka hela förslaget. Godkännande krävs innan det blir ett minne. |
| Inget nytt, väntande förslag eller paus | Fortsätt samtalet utan ett nytt erbjudande. |
| Dagens humör eller en engångsplan | Behandla det som samtalskontext, inte som en bestående profiluppgift. |

## Verifieringsgräns

Automatiska tester verifierar länkar, uppdaterade MCP-instruktioner, kontextbudget,
kompassens godkännandeflöde, pauser och webbgränssnitt. Webbläsarkontroll verifierar
layout, navigering och hjälp. Det bevisar inte en extern modells exakta svar.

MCP-instruktioner ligger i bakgrunden men startar inte på egen hand ett nytt svar i
ChatGPT, Claude, Codex eller Cursor. Personen behöver fortfarande börja samtalet;
anslutningen kan behöva väljas i appen. Cursor kan återanvända en redan öppen chatt.
Inga dagliga påminnelser eller automatiska meddelanden skapas av den här funktionen.
