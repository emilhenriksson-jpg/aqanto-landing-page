/**
 * Live token meter against the profile ceiling. The one place a limit is reassuring:
 * it shows the memory is curated rather than hoarded.
 */
export function TokenMeter({ used, ceiling }: { used: number; ceiling: number }) {
  const ratio = Math.min(1, used / ceiling);
  const pct = Math.round(ratio * 100);

  return (
    <div className="token-meter" aria-label={`Profilen använder ${used} av ${ceiling} tokens`}>
      <div className="token-meter__track">
        <div className="token-meter__fill" style={{ width: `${pct}%` }} />
      </div>
      <p className="token-meter__label">
        {used} / {ceiling} tokens · kuraterat
      </p>
    </div>
  );
}
