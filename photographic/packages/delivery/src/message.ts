/**
 * What the code looks like when it arrives.
 *
 * This is the first thing anyone who is not Emil will ever see of Photographic, which
 * makes it a product surface rather than a transactional nicety. `DESIGN.md`: Swedish,
 * plain and direct, no exclamation marks, no assistant chirpiness, one violet and
 * nothing else with colour.
 *
 * Kept as data — subject, text, html — rather than sent from here, so the copy can be
 * asserted without a provider and a provider can be swapped without touching the words.
 */

import type { SignupChannel } from '@photographic/connect';

/** Matches `CODE_TTL_MS` in `@photographic/connect`. Stated in minutes, as a person reads it. */
export const CODE_TTL_MINUTES = 10;

export interface CodeMessage {
  subject: string;
  text: string;
  html: string;
}

export interface CodeMessageInput {
  code: string;
  ttlMinutes?: number;
}

/**
 * The code goes in the subject line as well as the body.
 *
 * On a phone that means the notification is the whole answer and the person never opens
 * the mail. The argument against is that a subject is more likely to be shown on a
 * lock screen — but the code is single-use, expires in minutes, and is worthless without
 * the request it belongs to, which lives in the browser that asked for it.
 */
export function codeEmail(input: CodeMessageInput): CodeMessage {
  const ttl = input.ttlMinutes ?? CODE_TTL_MINUTES;

  return {
    subject: `${input.code} är din kod till Photographic`,
    text: text(input.code, ttl),
    html: html(input.code, ttl),
  };
}

/** SMS has one line to work with, and no styling to hide behind. */
export function codeSms(input: CodeMessageInput): string {
  const ttl = input.ttlMinutes ?? CODE_TTL_MINUTES;
  return `${input.code} är din kod till Photographic. Gäller i ${ttl} minuter.`;
}

export function codeMessageFor(channel: SignupChannel, input: CodeMessageInput): CodeMessage | string {
  return channel === 'email' ? codeEmail(input) : codeSms(input);
}

function text(code: string, ttl: number): string {
  return [
    code,
    '',
    `Koden gäller i ${ttl} minuter och kan bara användas en gång.`,
    '',
    'Bad du inte om att logga in? Då behöver du inte göra något. Koden är',
    'värdelös utan webbläsaren som begärde den.',
    '',
    'Photographic',
  ].join('\n');
}

/**
 * Inline styles and a system font stack, both on purpose.
 *
 * Mail clients strip `<style>` blocks and most will not load a webfont, so `DESIGN.md`'s
 * Inter is asked for and then given somewhere sane to land rather than pretended about.
 * Everything else — the violet, the tracking, the radius — survives as inline CSS.
 */
function html(code: string, ttl: number): string {
  const font =
    "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

  return `<!doctype html>
<html lang="sv">
  <body style="margin:0;padding:40px 24px;background:#f2f4f5;font-family:${font};color:#0a0a0a;">
    <div style="max-width:420px;margin:0 auto;">
      <div style="font-size:16px;font-weight:500;letter-spacing:-0.01em;color:#5433eb;margin-bottom:32px;">Photographic</div>

      <div style="background:#ffffff;border-radius:20px;padding:32px;box-shadow:0 2px 4px -2px rgba(0,0,0,0.06), 0 8px 24px -8px rgba(0,0,0,0.10);">
        <div style="font-size:32px;font-weight:600;letter-spacing:0.12em;line-height:1.2;">${escapeHtml(code)}</div>
        <div style="font-size:14px;color:#6b7280;margin-top:12px;letter-spacing:-0.005em;">
          Gäller i ${ttl} minuter och kan bara användas en gång.
        </div>
      </div>

      <div style="font-size:13px;color:#6b7280;margin-top:28px;line-height:1.6;letter-spacing:-0.005em;">
        Bad du inte om att logga in? Då behöver du inte göra något. Koden är värdelös utan
        webbläsaren som begärde den.
      </div>
    </div>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
