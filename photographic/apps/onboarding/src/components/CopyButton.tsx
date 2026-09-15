import { useEffect, useState } from 'react';

/**
 * Falls back to a hidden textarea because `navigator.clipboard` is unavailable in
 * non-secure contexts, and a copy button that silently fails is worse than none.
 */
async function copy(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const area = document.createElement('textarea');
  area.value = value;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  document.execCommand('copy');
  area.remove();
}

export function CopyButton({
  value,
  label,
  variant = 'default',
}: {
  value: string;
  label: string;
  variant?: 'default' | 'primary' | 'quiet';
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const className = [
    'btn',
    variant === 'primary' ? 'btn--primary' : '',
    variant === 'quiet' ? 'btn--quiet' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type="button"
      className={className}
      disabled={value.length === 0}
      onClick={() => {
        void copy(value).then(() => setCopied(true));
      }}
    >
      {copied ? 'Kopierat' : label}
    </button>
  );
}
