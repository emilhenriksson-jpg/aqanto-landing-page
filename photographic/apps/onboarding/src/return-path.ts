/** Accept only a product path on this origin, including after URL normalization. */
export function safeReturnTo(value: string | null): string | undefined {
  if (!value || !value.startsWith('/') || Array.from(value).some(char => char === '\\' || char.charCodeAt(0) <= 32)) return undefined;
  const base = 'https://photographic.invalid';
  try {
    const url = new URL(value, base);
    if (url.origin !== base) return undefined;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch { return undefined; }
}
