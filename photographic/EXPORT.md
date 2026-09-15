# Export och radering

Två saker byggda tidigt med avsikt. De är precis de funktioner som skjuts upp tills
någon frågar, och då är de inte längre möjliga att bygga billigt: en export är portabel
bara om loggen sparades i en form som går att strömma ut, och en radering är ärlig bara
om schemat byggdes med en radering i tankarna.

Att det stämmer visade sig direkt. Se "Den upptäckt som kostade en migration" längst ner.

## Arkivet

```
photographic-export-<handle>-<ÅÅÅÅ-MM-DD>.zip
├── README.md              Vad det här är, på svenska, läsbart utan Photographic
├── manifest.json          format_version, person, tidpunkt, rum, antal, seq-intervall, sha256 per fil
├── events.ndjson          Hela loggen, en händelse per rad, sorterad på seq
├── items.ndjson           Nuläget som projektion — bekvämlighet, inte sanning
├── rooms.json             Rum, roller, medlemmar (visningsnamn)
├── people.json            Personer som förekommer som aktörer
├── documents.ndjson       Dokumentmetadata, inklusive sökväg i arkivet
└── documents/<rum>/<id>-<filnamn>
```

Loggen är med därför att byggplanens beslut 9 säger att exporten är loggen plus
filerna. En export av bara `app.item` är en export av en projektion: den som importerar
den har fått nuläget utan att kunna svara på hur det blev så, och proveniensen är halva
produkten.

NDJSON strömmar i båda riktningarna — `ZipWriter` skriver med data descriptors så en
post kan skrivas utan att dess längd är känd i förväg, och en läsare kan ta en rad i
taget. En exportfil som måste läsas in i minnet i sin helhet är oanvändbar för exakt de
användare som har mest att förlora.

`format_version` finns i manifestet eftersom skälet att exportera sitt minne är att
kunna lita på att det går att läsa om tio år.

## Beslut 1: vad en export gör med delade rum

**Beslut: som standard innehåller arkivet personens eget — hela det privata rummet, plus
det hon själv har skrivit i delade rum. Ett helt rumsutdrag är en separat, uttrycklig
begäran per rum.**

Det här avviker från designdokumentet, som sätter omfattningen till `accessible_room_ids`
— alltså fullständiga utdrag ur varje delat rum hon är medlem i — med motiveringen att
"hon kan läsa allt det i appen ändå". Jag tycker inte den motiveringen håller, av tre
skäl.

**Åtkomst går att återkalla, en zip gör det inte.** Att läsa ett rum i appen är
villkorat av *nuvarande* medlemskap: `resolveActor` snittar tokenens räckvidd mot
aktuella medlemskap vid varje anrop, och förtroendedokumentet pekar uttryckligen ut att
den designen är rätt och inte får bli cachning. Ett fullständigt rumsutdrag är precis den
förbjudna cachningen, gjord permanent och flyttad utanför vår infrastruktur. Utesluts
Elias ur Buyersclub Ledning i morgon slutar appen visa honom rummet; zip-filen på hans
laptop gör det inte.

**Dokumentets eget argument om gemensamt minne pekar åt andra hållet.** Avsnitt 1.3
låter en avhoppad medlems anteckningar stanna i rummet, med motiveringen att ett delat
rum är ett *gemensamt* arbetsminne och att ingen enskild medlem ensidigt får ändra vad de
andra minns. Om det är sant är ett fullständigt utdrag inte en medlems data att ta med —
det är gruppens. Att ta det ensidigt är samma sorts handling som 1.3 förbjuder, bara i
motsatt riktning.

**Portabilitet och åtkomst är två olika saker.** Produktlöftet — byt AI utan att börja
om — handlar om *hennes* minne. Andra medlemmars bidrag är uppgifter de själva lämnat om
sig; en maskinläsbar kopia av dem är inte det som gör hennes minne portabelt.

Priset för att avvika är att ett `own`-arkiv kan tappa sammanhang: ett beslut av hennes
som refererar till någon annans underlag blir svårare att förstå. Därför innehåller
arkivet fortfarande rummets metadata och medlemslista — vem man delar ett rum med är
hennes att veta — och README:n säger rakt ut vilka rum som bara finns med delvis, och att
ett helt rum går att begära separat.

**Båda vägarna skriver `export.created` till varje rum de omfattar**, med `included: own`
eller `included: full` i payloaden. Det är designdokumentets krav på synlighet, och det
som gör det starkare draget synligt starkare: rummets medlemmar kan se skillnad på "Emil
tog en kopia av sina egna bidrag" och "Emil tog en kopia av hela rummet".

Ett rum-id i en begäran är en begäran, aldrig en behörighet. Det snittas mot verkliga
medlemskap både när begäran görs och igen när jobbet körs — ett rum hon lämnat
däremellan hamnar inte i arkivet.

## Beslut 2: vad en radering gör med delade rum

**Beslut: bidragen stannar, pseudonymiserade, precis som samtyckestexten lovade — och
personen får välja bort det.**

Här finns ingen motsättning att lösa upp, vilket är värt att säga eftersom det ser ut som
att det kunde finnas en. Samtyckestexten vid inbjudan säger *det du skriver i ett delat
rum blir en del av rummet och stannar där även om du senare lämnar det.* En radering som
strök bidragen skulle motsäga ett löfte produkten gav i första vyn, innan personen skrev
något — och skulle tyst ändra vad de andra medlemmarna minns, vilket är exakt det
avsnitt 1.3 finns för att förhindra.

Att behålla dem kräver i stället ärlighet vid raderingstillfället, och det är redan
skrivet: `DELETION_SHARED_ROOM_NOTICE` säger att bidragen står kvar under "Borttagen
användare". Det som gör hållningen försvarbar är att valet finns och är verkligt:

- `contributions` är **obligatoriskt** i API:et och `NOT NULL` utan default i schemat. En
  radering kan inte registreras utan att valet har gjorts. Samtyckestexten säger att
  valet aldrig är förvalt; en obligatorisk kolumn är det som gör det till en egenskap hos
  systemet i stället för en konvention i ett gränssnitt, så att ett framtida admin-skript
  inte kan hoppa över det.
- Väljer personen `remove` går bidragen genom den vanliga papperskorgen — synligt för de
  andra medlemmarna, med motivering, återställbart av en owner i trettio dagar. Ingen
  tyst massradering.

**Det är pseudonymisering, inte anonymisering.** Personraden finns kvar som gravsten, så
den som minns vem som skrev en anteckning kan fortfarande återidentifiera den. Att påstå
något annat vore ett löfte datamodellen inte kan hålla.

Gravstenen är för övrigt tvingad av schemat, inte valfri: `app.event.actor_person_id` och
`app.room.created_by` pekar på `app.person` utan cascade, och loggen vägrar DELETE. En
kaskadradering skulle antingen misslyckas eller ta bort historiken för alla som delat rum
med personen.

## De två raderingsvägarna

Båda erbjuds, enligt Emils beslut.

| | Frysning (30 dagar) | Radera nu |
|---|---|---|
| Tokens återkallas | omedelbart | omedelbart |
| Går att ångra | i 30 dagar | nej |
| Export fungerar under tiden | ja | begärs innan |
| Bekräftelse | knappen | skriv `radera nu` |

Tokens återkallas direkt på **båda** vägarna. Det är vad som gör frysningen gratis
integritetsmässigt: under den är kontot redan onåbart för varje ansluten AI, och fönstret
köper bara möjligheten att ändra sig. Förstapartssessioner i webben rörs inte — personen
måste kunna logga in för att avbryta och för att exportera.

Att avbryta återställer inte tokens. En klient som tyst fick tillbaka åtkomst till ett
minne personen beslutat att radera är fel standard även efter att hon ändrat sig.

Den omedelbara vägen kräver att `radera nu` skrivs in. Den hårdare varningen är beslutet;
en inskriven fras är det som hindrar en dubbelklick från att hoppa över trettio dagars
ångerrätt.

## Vad en radering faktiskt tar bort

Hårt, i den här ordningen — filer före raderna som namnger dem, eftersom lagringen är
innehållsadresserad och `storage_key` är enda vägen in till bytesen:

- Filer i objektlagringen, via storage-porten. Utom de som ett delat rum fortfarande
  pekar på: samma fil i två rum är ett objekt, och att radera det skulle förstöra det
  delade rummets kopia.
- Det personliga rummet med allt som kaskadar ur det — item, document, chunk, brief,
  event. Papperskorgens trettio dagar gäller inte här; frysningen var fönstret.
- Lagringsräknare, exportarkiv (ett komplett minne i objektlagringen som annars låg kvar
  och gjorde raderingen kosmetisk), credentials, OAuth-klienter och tokens, sessioner,
  access-loggar.
- Kontaktuppgifter: e-post, telefon. Handle roteras, visningsnamn blir "Borttagen
  användare", `deleted_at` sätts.

Medlemskap i delade rum avslutas, så ett raderat konto inte räknas som medlem.

`account_deletion.removed` sparar antalen efteråt. Personraden är en gravsten då, så det
är enda stället som kan svara på vad som hände — och en radering ingen kan visa att den
kördes är inte mycket till radering.

## Den upptäckt som kostade en migration

Raderingen gick inte att implementera alls mot det befintliga schemat, och det visade sig
genom att skriva den och köra den.

`app.event.room_id` refererar `app.room` med ON DELETE CASCADE, och den append-only-
trigger som skyddar loggen vägrar DELETE. Så `DELETE FROM app.room` på ett personligt rum
ger `app.event is append-only (attempted DELETE)`. Inte obekvämt — omöjligt.

Migration `0014_permit_personal_room_erasure.sql` öppnar en smal lucka, i en egen fil med
det namnet, eftersom en utvidgning av append-only-garantin inte är något någon ska
upptäcka inuti en migration som heter "export and deletion". Formen är densamma som 0002
redan valde när den behövde en lucka för redigering: en sessionsflagga som en enda
funktion sätter och alltid nollar.

Det som håller luckan smal:

- Flaggan sätts med `set_config(..., true)` och är alltså transaktionslokal.
- `app.erase_personal_room` är det enda som sätter den, och nollar den på varje väg ut.
- Funktionen tar en **person**, inte ett rum, och avvisar allt som inte är den personens
  eget personliga rum. Ett delat rums historik går inte att nå genom den.
- UPDATE är fortfarande bara tillåtet under 0002:s redigeringsflagga. Ingen av flaggorna
  ger den andra.

Sju tester försöker missbruka luckan i stället för att använda den rätt: vanlig DELETE
och UPDATE avvisas fortfarande, flaggan läcker inte till nästa sats på samma anslutning,
och ett delat rums historik är oförändrad genom en hel kontoradering.

**Till spår 2:** det här ändrar en garanti ni äger. Invarianten är nu "append-only utom
inifrån `app.purge_expired_items` (UPDATE) och `app.erase_personal_room` (DELETE)".
Omorganiseras triggern måste båda luckorna följa med, annars går kontoradering sönder.

## Ärligt om det som inte är klart

**Arkivet buffras en gång innan det laddas upp.** `buildExportArchive` strömmar hela
vägen, men `BlobStore.put` tar bytes — det är vad både Supabase Storages REST-API och en
S3 single-part PUT vill ha. Så arkivet är resident en kort stund i `PgExports.run`.
`ZipWriter` vägrar allt över 4 GB, vilket gör det begränsat snarare än obegränsat, men
rätt lösning är multipart-uppladdning bakom porten. Det är nästa steg, inte ett gjort
steg.

**`export.created` syns inte i historiken än.** Händelsen skrivs till loggen, som är
sanningen, men `app.activity`-vyn filtrerar på händelsetyp och känner inte igen den. Vyn
ägs av spår 2 tillsammans med resten av domänen, så den ändringen ligger hos dem
(tillsammans med `account.deletion_requested` och `account.deletion_cancelled`). Fram
till dess finns händelserna i loggen och i exporten men inte på historikskärmen.

**Ingen leverans av länken.** Exporten blir klar och länken går att hämta via API:et, men
inget e-postmeddelande skickas ännu. `@photographic/delivery` finns nu på foundation och
är rätt ställe att koppla in det.

**Ingen webb-yta.** Export och radering finns som API och som kopia i
`packages/core/src/consent.ts`, men inga skärmar. Kopian är serverad från
`GET /v1/account/deletion` snarare än duplicerad i klienten, så orden en person läser
innan hon raderar sitt konto inte kan glida ifrån orden inbjudan lovade henne.
