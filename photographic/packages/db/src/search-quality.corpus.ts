/**
 * The Swedish search-quality corpus, committed.
 *
 * The 81%-versus-100% figures in `STATUS.md` came from a measurement whose corpus and
 * harness were scratch files, deleted after use. That made the two numbers a decision
 * rests on unre-checkable: nothing in the repo could disagree with them. This file and
 * `search-quality.test.ts` exist so the numbers are a test result rather than a quote.
 *
 * Categories are the ones the original measurement used, because the whole point of the
 * exercise was that the aggregate hides the only interesting number: on `hard-paraphrase`
 * — a question with no content word in common with its answer, which is what asking your
 * memory something you do not remember phrasing actually looks like — every lexical and
 * trigram strategy scored zero and real embeddings scored everything.
 *
 * This is a reconstruction of a corpus of the same shape and the same category mix, not
 * the original 25 memories and 27 questions, which no longer exist. It therefore
 * corroborates the original numbers rather than reproducing them, and the report says so.
 */

export type QuestionCategory =
  | 'near-exact'
  | 'inflection'
  | 'synonym'
  | 'compound'
  | 'hard-paraphrase';

export interface CorpusMemory {
  /** Stable key a question points at. Not the short id, which is generated per run. */
  key: string;
  body: string;
  /** `personal` or the shared room; both are in scope for `RetrievalPort.search`. */
  room: 'personal' | 'ledning';
}

export interface CorpusQuestion {
  query: string;
  /** Which memory is the right answer. */
  expects: string;
  category: QuestionCategory;
  /** Why this one is hard, where that is not obvious from the words. */
  note?: string;
}

export const CORPUS_MEMORIES: readonly CorpusMemory[] = [
  { key: 'ketchup', body: 'Allergisk mot ketchup', room: 'personal' },
  { key: 'vera', body: 'Dottern Vera fyller år den 3 februari', room: 'personal' },
  { key: 'goteborg', body: 'Bor i Göteborg sedan flytten 2021', room: 'personal' },
  { key: 'volvo', body: 'Kör en Volvo V60 från 2019', room: 'personal' },
  { key: 'innebandy', body: 'Spelar innebandy på onsdagskvällar', room: 'personal' },
  { key: 'tag', body: 'Föredrar tåg framför flyg inom Sverige', room: 'personal' },
  { key: 'bror', body: 'Har en bror som heter Elias', room: 'personal' },
  { key: 'kaffe', body: 'Dricker kaffe svart, aldrig med mjölk', room: 'personal' },
  { key: 'korta-svar', body: 'Vill ha korta svar utan inledande artighetsfraser', room: 'personal' },
  { key: 'hemifran', body: 'Arbetar hemifrån på måndagar och fredagar', room: 'personal' },
  { key: 'facklitteratur', body: 'Läser mest facklitteratur, sällan romaner', room: 'personal' },
  {
    key: 'uppsagningstid',
    body: 'Uppsägningstiden på lägenheten i Stockholm är tre månader',
    room: 'personal',
  },
  { key: 'fullmane', body: 'Sover dåligt när det är fullmåne', room: 'personal' },

  {
    key: 'forvarv',
    body: 'Vi beslutade att skjuta förvärvet av Buyersclub till Q3',
    room: 'ledning',
  },
  { key: 'budget', body: 'Styrelsen godkände budgeten för nästa kvartal', room: 'ledning' },
  {
    key: 'omsattning',
    body: 'Omsättningen ökade med 18 procent under första halvåret',
    room: 'ledning',
  },
  {
    key: 'marknadsforing',
    body: 'Marknadsföringsbudgeten höjs med 400 000 kronor',
    room: 'ledning',
  },
  {
    key: 'rapportering',
    body: 'Ledningen ansvarar för att rapportera till styrelsen varje månad',
    room: 'ledning',
  },
  { key: 'kontrakt', body: 'Kontraktet med leverantören löper ut i december', room: 'ledning' },
  { key: 'prisplan', body: 'Vi lanserar den nya prisplanen i september', room: 'ledning' },
  {
    key: 'uppdateringar',
    body: 'Uppdateringarna av plattformen flyttas till efter sommaren',
    room: 'ledning',
  },
  {
    key: 'due-diligence',
    body: 'Due diligence-paketet skickas till köparen på fredag',
    room: 'ledning',
  },
  { key: 'kundsupport', body: 'Elias tar över ansvaret för kundsupporten', room: 'ledning' },
  { key: 'kontorsflytt', body: 'Vi flyttar kontoret till Lindholmen i januari', room: 'ledning' },
  {
    key: 'offert',
    body: 'Peab har offererat 340 000 kronor för köksrenoveringen',
    room: 'ledning',
  },
];

export const CORPUS_QUESTIONS: readonly CorpusQuestion[] = [
  // near-exact: the question shares most of its content words with the answer.
  { query: 'Vad är jag allergisk mot?', expects: 'ketchup', category: 'near-exact' },
  { query: 'När fyller Vera år?', expects: 'vera', category: 'near-exact' },
  { query: 'Var bor jag?', expects: 'goteborg', category: 'near-exact' },
  { query: 'Vilken bil kör jag?', expects: 'volvo', category: 'near-exact' },
  {
    query: 'Vad beslutade vi om förvärvet av Buyersclub?',
    expects: 'forvarv',
    category: 'near-exact',
  },
  {
    query: 'Hur mycket ökade omsättningen första halvåret?',
    expects: 'omsattning',
    category: 'near-exact',
  },
  {
    query: 'När löper kontraktet med leverantören ut?',
    expects: 'kontrakt',
    category: 'near-exact',
  },
  { query: 'Vem tar över kundsupporten?', expects: 'kundsupport', category: 'near-exact' },
  { query: 'När lanserar vi den nya prisplanen?', expects: 'prisplan', category: 'near-exact' },
  {
    query: 'Vad har Peab offererat för köksrenoveringen?',
    expects: 'offert',
    category: 'near-exact',
  },

  // inflection: same lexeme, different grammatical form.
  {
    query: 'Har styrelsen godkänt budgeten?',
    expects: 'budget',
    category: 'inflection',
    note: 'godkänt/godkände — a pair neither this stemmer nor Postgres unifies',
  },
  { query: 'Hur ser omsättning ut?', expects: 'omsattning', category: 'inflection' },
  {
    query: 'Vilken uppdatering av plattformen är framflyttad?',
    expects: 'uppdateringar',
    category: 'inflection',
  },
  {
    query: 'Vem ansvarar för rapportering till styrelsen?',
    expects: 'rapportering',
    category: 'inflection',
  },
  {
    query: 'Vad säger ledningens plan för rapportering?',
    expects: 'rapportering',
    category: 'inflection',
  },
  { query: 'När flyttades kontoret?', expects: 'kontorsflytt', category: 'inflection' },
  {
    query: 'Vad kostar marknadsföringsbudget?',
    expects: 'marknadsforing',
    category: 'inflection',
  },

  // synonym: different word for the same idea, one shared anchor noun.
  {
    query: 'Hur mycket höjs reklambudgeten?',
    expects: 'marknadsforing',
    category: 'synonym',
    note: 'marknadsföring/reklam',
  },
  {
    query: 'Vad hände med uppköpet av Buyersclub?',
    expects: 'forvarv',
    category: 'synonym',
    note: 'förvärv/uppköp',
  },
  {
    query: 'Vilket avtal med leverantören går ut snart?',
    expects: 'kontrakt',
    category: 'synonym',
    note: 'kontrakt/avtal',
  },
  {
    query: 'Vad är min uppsägningstid på bostaden i Stockholm?',
    expects: 'uppsagningstid',
    category: 'synonym',
    note: 'lägenhet/bostad',
  },

  // compound: Swedish compounding split differently than the memory wrote it.
  {
    query: 'Hur lång är uppsägning på lägenheten?',
    expects: 'uppsagningstid',
    category: 'compound',
    note: 'uppsägning vs uppsägningstiden — the case the trigram arm exists for',
  },

  // hard-paraphrase: no content word in common at all. The category that decides the
  // embedding question, and the one every lexical strategy scored zero on.
  {
    query: 'Vilken mat måste jag undvika?',
    expects: 'ketchup',
    category: 'hard-paraphrase',
  },
  {
    query: 'Hur reser jag helst?',
    expects: 'tag',
    category: 'hard-paraphrase',
  },
  {
    query: 'Hur ska jag skriva till dig?',
    expects: 'korta-svar',
    category: 'hard-paraphrase',
  },
  {
    query: 'Vilka dagar jobbar jag inte från arbetsplatsen?',
    expects: 'hemifran',
    category: 'hard-paraphrase',
  },
  {
    query: 'Varför är jag trött vissa nätter?',
    expects: 'fullmane',
    category: 'hard-paraphrase',
  },
];
