/**
 * pgvector literal formatting, by hand.
 *
 * There is no `pgvector` client dependency in this package -- one array-to-string
 * conversion does not justify a new dependency. Postgres accepts a vector as the text
 * literal `[0.1,0.2,...]` cast with `::vector`; this is that literal, nothing more.
 */
export function toVectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(',')}]`;
}
