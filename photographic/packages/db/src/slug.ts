/** Mirrors `MemoryIdentity`'s slugify. Kept here rather than imported so this package
 * does not depend on the reference implementation for a five-line function. */
export function slugify(title: string): string {
  const base = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'rum';
}

export const PERSONAL_ROOM_SLUG = 'personal';
