/**
 * Nödinloggning — one sign-in link for one phone number, minted on the machine.
 *
 * Run this on the host, never from the network:
 *
 *   fly ssh console -C 'node --import tsx /app/scripts/break-glass-signin.ts 070-123 45 67'
 *
 * It prints a link. Opening the link signs that number's account in, once, within ten
 * minutes. `scripts/deploy.md` has the owner-facing version of these instructions, in
 * Swedish, written for someone who is locked out and in a hurry.
 *
 * **Why this exists.** Sign-in codes travel by SMS. When no SMS provider is configured,
 * production refuses to send rather than writing the code to the application log — a
 * credential in a log is reachable by anything that can read logs, including a read-only
 * deploy token, which made "read the log" a way into any account. Refusing closes that,
 * and would leave nobody able to sign in on a day the provider is down. This is the door
 * that makes closing the other one safe.
 *
 * **Why it is safer than the log it replaces**, which is the only claim that matters:
 *
 * - It requires a shell on the running machine. That is deploy-level access, not the
 *   read-level access `fly logs` needs, and it cannot be reached over HTTP at all — no
 *   route, no header, no flag turns this file on. It is a file that is executed by a
 *   person on the host.
 * - It names one account. The log route handed out a code for *any* number anyone typed
 *   into the form; this signs a token for one number, and refuses if that number has no
 *   account rather than creating one.
 * - It leaves a record. Every mint appends `session.break_glass_minted` to the append-only
 *   event log, in that person's own room, so it shows up in their own history. Reading a
 *   code out of the log left no trace anywhere.
 * - It expires in ten minutes and is spent on first use. A log line was valid for as long
 *   as the retention window.
 *
 * Deliberately not a way to create accounts, reset anything, or read memory: it mints one
 * short-lived credential for one existing person, and that is all it can do.
 */

import { checkSwedishMobile, mintBreakGlassToken, MOBILE_EXAMPLE } from '@photographic/connect';
import { createPool, createPostgresServices } from '@photographic/db';

const USAGE = `Användning: node --import tsx scripts/break-glass-signin.ts <mobilnummer>

  Exempel: node --import tsx scripts/break-glass-signin.ts ${MOBILE_EXAMPLE}

Kräver DATABASE_URL och BREAK_GLASS_SECRET i maskinens miljö, vilket de är i
produktion. Skriptet skapar inga konton och läser inga minnen.`;

async function main(): Promise<void> {
  // Joined rather than taken as one argument, so `fly ssh console -C` with a number
  // written the way a person writes it — spaces and all — does not fail on argument
  // splitting while someone is locked out.
  const written = process.argv.slice(2).join(' ').trim();
  if (!written || written === '--help' || written === '-h') fail(USAGE);

  const secret = process.env.BREAK_GLASS_SECRET;
  if (!secret) {
    fail(
      'BREAK_GLASS_SECRET är inte satt i den här miljön, så ingen nödinloggning kan skapas.\n' +
        'Sätt den en gång, som en Fly-secret:\n\n' +
        '  fly secrets set BREAK_GLASS_SECRET=$(openssl rand -hex 32)\n\n' +
        'Maskinen startar om, och sedan fungerar det här skriptet.',
    );
  }

  // The same reader the form and the endpoint use. A number written five ways is one
  // number, and a second opinion about that here is how an account gets split in two.
  const phone = checkSwedishMobile(written);
  if (!phone.ok) fail(phone.message);

  if (!process.env.DATABASE_URL) {
    fail(
      'DATABASE_URL är inte satt, så det finns ingen databas att slå upp numret i.\n' +
        'Kör det här på maskinen (`fly ssh console`), inte på en laptop.',
    );
  }

  const pool = createPool();
  const wired = await createPostgresServices({
    pool,
    baseUrl: process.env.PUBLIC_URL ?? 'https://mcp.photographic.space',
  });

  try {
    const person = await wired.services.identity.findByPhone(phone.e164);
    if (!person) {
      fail(
        `Det finns inget konto för ${phone.e164}.\n` +
          'Nödinloggningen är en väg tillbaka in i ett konto som redan finns — den skapar inga nya.',
      );
    }

    const minted = mintBreakGlassToken({ personId: person.id, secret });

    /**
     * The record, written before the link is printed.
     *
     * In the person's own room, so it appears in their own history beside everything else
     * that ever happened to their memory — the point is not an audit file somewhere, it is
     * that the person can see that this happened. Appended first: a mint that could not be
     * recorded is one that must not be handed out.
     */
    const personalRoom = await wired.services.identity.personalRoomOf(person.id);
    await wired.services.events.append({
      roomId: personalRoom.id,
      eventType: 'session.break_glass_minted',
      payload: {
        jti: minted.jti,
        expiresAt: minted.expiresAt.toISOString(),
        // Never the token, and never the whole number: enough to tell two accounts apart
        // in a log, not enough to be someone's contact details.
        phoneSuffix: phone.e164.slice(-4),
      },
      actorPersonId: person.id,
      agentClient: 'api',
      explicit: true,
      motivation: 'Nödinloggning skapad på maskinen.',
    });

    const base = (process.env.PUBLIC_URL ?? 'https://mcp.photographic.space').replace(/\/+$/, '');
    const minutes = Math.round((minted.expiresAt.getTime() - Date.now()) / 60_000);

    // The token goes in the fragment. Everything before `#` reaches the server and can be
    // logged by it; nothing after `#` is ever sent. See `apps/rest/src/break-glass-page.ts`.
    process.stdout.write(
      [
        '',
        `Nödinloggning för ${phone.e164} (konto ${person.id}).`,
        `Öppna den här länken i din webbläsare inom ${minutes} minuter:`,
        '',
        `  ${base}/nodlage#${minted.token}`,
        '',
        'Länken gäller en gång. Efter det, eller när tiden gått ut, kör skriptet igen.',
        'Klistra inte in den i en chatt och spara den inte — den loggar in som du.',
        '',
      ].join('\n'),
    );
  } finally {
    await wired.close();
  }
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

await main();
