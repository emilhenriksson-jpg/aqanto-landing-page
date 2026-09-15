/**
 * What a person is told before they join a shared room, and before they delete an
 * account.
 *
 * These strings are here rather than inside a screen because they are the same promise
 * on every surface that makes it, and because one of them has a legal side. A shared
 * room keeps what you wrote in it even after you leave — that is the decision, it is
 * defensible, and it is only defensible if it is said *before* someone writes forty
 * notes into a room rather than discovered afterwards.
 *
 * Swedish, because every one of them is read by a person. Kept short enough to sit under
 * a button without becoming the kind of paragraph nobody reads.
 */

/**
 * The invite consent line. Shown on the invite landing, next to the join button.
 *
 * Load-bearing: the whole justification for contributions surviving a departure is that
 * the person was told. A screen that omits this makes the product's position on other
 * people's memory into something we took without asking.
 */
export const SHARED_ROOM_CONSENT =
  'Det du skriver i ett delat rum blir en del av rummet och stannar där även om du ' +
  'senare lämnar det. Du kan alltid ta bort dina egna bidrag medan du är medlem.';

/** The same fact, one line shorter, for places with no room for the sentence above. */
export const SHARED_ROOM_CONSENT_SHORT =
  'Vad du skriver i rummet stannar i rummet, även om du lämnar det.';

/**
 * Offered before leaving a room or deleting an account — never preselected.
 *
 * Not a default in either direction, because a default here is a decision taken on
 * someone's behalf about other people's memory. Leaving it on would quietly empty a
 * shared room the rest of the team still works in; leaving it off and hiding it would
 * mean a person who wanted their notes gone never saw that they could.
 */
export const REMOVE_MY_CONTRIBUTIONS =
  'Ta bort mina bidrag först. De hamnar i papperskorgen, syns för rummets andra ' +
  'medlemmar och kan återställas av en ägare i 30 dagar.';

/**
 * The two deletion paths, both offered.
 *
 * The freeze is the recommended one and is symmetric with the trash: thirty days
 * because it has to outlast a holiday, and it costs nothing in privacy because every
 * token is revoked the moment the request is made — the account stops being reachable
 * in the same second either way. The immediate path exists because "delete now" should
 * mean it for the people who want that, and it carries the harder warning because it is
 * the one that cannot be undone.
 */
export const DELETION_FREEZE_EXPLANATION =
  'Kontot slutar vara nåbart direkt: alla anslutna AI:er kopplas bort och alla ' +
  'tokens återkallas. Du har 30 dagar att ändra dig innan raderingen genomförs. ' +
  'Under tiden kan du logga in och exportera ditt minne.';

export const DELETION_IMMEDIATE_WARNING =
  'Raderas nu, utan 30 dagars ångerfrist. Ditt privata minne, dina dokument och dina ' +
  'filer tas bort permanent och går inte att få tillbaka. Exportera först om du vill ' +
  'behålla en kopia.';

/**
 * What happens to a person's traces in shared rooms when the account goes.
 *
 * Stated plainly because "pseudonymised rather than deleted" is the part people are
 * surprised by, and being surprised by it later is what makes it feel like a trick.
 */
export const DELETION_SHARED_ROOM_NOTICE =
  'Dina bidrag i delade rum stannar kvar, men de står inte längre i ditt namn — de ' +
  'visas som "Borttagen användare". Dina kontaktuppgifter och ditt privata minne ' +
  'raderas helt.';
