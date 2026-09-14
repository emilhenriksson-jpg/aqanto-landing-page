# Photographic — design language

The reference is the Shop app (shop.app). Not a developer tool, not a dashboard: a calm
consumer app where the interface disappears and the content is the only thing with
voltage.

The feeling to chase: **you are standing inside your own room.** Not looking at a list
of records — inside a space that belongs to you, that knows you, and that you can walk
between.

## Tokens

```css
--canvas:        #f2f4f5;   /* page background, faint cool grey */
--surface:       #ffffff;   /* cards, sheets, bars */
--ink:           #0a0a0a;   /* text, near black */
--ink-muted:     #6b7280;   /* secondary text */
--hairline:      rgba(10, 10, 10, 0.08);

--brand:         #5433eb;   /* the ONLY saturated colour in the product */
--brand-soft:    #efecfe;   /* brand tint for fills */
--brand-shadow:  0 4px 24px rgba(69, 36, 219, 0.34);

--ok:            #0f9d58;   /* client connected, profile delivered */
--warn:          #d97706;   /* delivered by a best-effort channel */
--bad:           #dc2626;   /* profile never reached this client */

--radius-md:     14px;
--radius-xl:     20px;      /* dominant card radius */
--radius-xxl:    28px;      /* hero cards, sheets */
--radius-pill:   999px;     /* every control */

--shadow-card:   0 2px 4px -2px rgba(0,0,0,0.06), 0 8px 24px -8px rgba(0,0,0,0.10);
--shadow-lift:   0 4px 8px -4px rgba(0,0,0,0.08), 0 16px 40px -12px rgba(0,0,0,0.16);
```

**One accent, used sparingly.** Violet appears on the wordmark, the primary action, the
voice button and the personal room. Nowhere else. If everything is violet, nothing is.

## Type

Inter (GT Standard is Shopify-proprietary; Inter is the correct substitute).

Restraint is the whole point. Shop uses no size above 20px and no weight above 400 on
its own surface, and lets content carry the page. We allow a little more because we
have no product photography, but stay close:

```
display   28px / 600 / -0.02em    room title inside a room
heading   20px / 500 / -0.01em    section headings
body      16px / 400 / -0.005em   default
label     14px / 500              card labels, chips
meta      13px / 400              timestamps, counts, provenance
mono      13px  ui-monospace      short ids only
```

Tight negative tracking is a signature of this look. Do not skip it.

## Layout

- Max width 1200px, centred on `--canvas`.
- Desktop: persistent 64px icon-only left rail.
- Mobile: the rail becomes a bottom tab bar. Mobile is the primary case — this is a
  product people use while talking, often on a phone.
- Generous vertical rhythm: 64–80px between major sections. Let it breathe.
- Cards sit on the canvas with soft ambient shadow, never with heavy borders.

## The core screens

**Rooms (home).** A grid of large rounded cards, one per room. The personal room is
first, always, visually distinct — violet-tinted fill, slightly larger, never
archivable. Each shared-room card shows title, member avatars, and an unseen count as a
small violet pill. This screen answers "where can I go".

**Inside a room.** Full-bleed header with the room title in display type, members, and
the brief rendered as calm prose rather than a data dump. Below it: memories as compact
cards grouped by kind, documents, and an activity feed. The person should feel located,
not like they opened a table.

**Inside the personal room.** The most important screen in the product. It is your
profile rendered as sections — Identity, Hard facts, Preferences, Instructions, Never,
Current focus — each a card group. Every line carries its short id as a quiet monospace
chip, with inline edit and a delete that always offers undo. There is a live token
meter against the ceiling: this is the one place where showing a limit is reassuring
rather than annoying, because it tells you the memory is curated rather than hoarded.

**Approvals.** A feed of cards: "Claude vill spara: *utmana alltid mina idéer*". Two
pill buttons, accept and dismiss, and a line stating which client proposed it and why
approval was needed. This screen must feel light and fast to clear, never like an
inbox to dread.

**Client health.** A row of cards, one per connected AI. Green when the profile reached
it and how, amber when it arrived by a best-effort channel, red when it never landed.
This is the honesty feature: we cannot force every client to read the personal room, so
we show the truth. Treat it as a hero feature, not a settings page.

**Invite.** What a recipient sees before they have an account: the room's actual
content, readable, with a single violet action to join. No signup wall. This screen is
the growth loop and deserves the most polish in the product.

## Motion

Spring, not linear. 200–260ms. Cards lift on hover with `--shadow-lift`. Room entry
should feel like moving *into* a space: the card the person tapped expands into the
room header rather than the page swapping. Respect `prefers-reduced-motion`.

## Voice

One large violet circular button, `--brand-shadow` beneath it, centred. While listening
it breathes slowly rather than pulsing aggressively. Transcript appears as calm text
above. When memory is written during a call, a small card slides in showing exactly
what was saved with its short id — the person must always see what the system took.

## Tone

Swedish throughout, plain and direct, no exclamation marks, no assistant chirpiness.
"Sparat i Buyersclub Ledning." not "Klart! Jag har sparat det åt dig! 🎉".

Never say "AI" to the user when a specific name works: say "Claude", "ChatGPT".
