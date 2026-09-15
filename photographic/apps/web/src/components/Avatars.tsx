/** Compact initial discs for room members. Brand stays off — canvas / ink only. */

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 1).toUpperCase();
  return `${parts[0]!.slice(0, 1)}${parts[parts.length - 1]!.slice(0, 1)}`.toUpperCase();
}

export function Avatars({
  names,
  variant = 'default',
}: {
  names: string[];
  variant?: 'default' | 'hero';
}) {
  if (names.length === 0) return null;

  return (
    <ul
      className={variant === 'hero' ? 'avatars avatars--hero' : 'avatars'}
      aria-label={names.length === 1 ? names[0] : `${names.length} medlemmar`}
    >
      {names.map((name) => (
        <li key={name} className="avatar" title={name} aria-hidden="true">
          {initials(name)}
        </li>
      ))}
    </ul>
  );
}
