/** Brand mark shared with onboarding: violet disc + name, never just nav text. */
export function Wordmark({ large = false }: { large?: boolean }) {
  return (
    <div className={large ? 'wordmark wordmark--large' : 'wordmark'}>
      <span className="wordmark__dot" aria-hidden="true" />
      <span className="wordmark__name">Photographic</span>
    </div>
  );
}
