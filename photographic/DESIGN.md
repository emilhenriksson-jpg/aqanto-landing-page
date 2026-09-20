# Photographic — design language

Updated 2026-09-20 after an independent GPT-5.5 critique and implementation review.

Photographic is a calm place between conversations: your memory, the people and
projects around you, and a way back into your chosen chat app. Content and actions
carry the interface. The product should feel personal, legible and unhurried.

## Hierarchy

- One brand in the app shell. Do not repeat a large logo above every page title.
- A personal greeting leads the start. Names come from the account, never demo guesses.
- Main actions are easy to find. Large equally weighted buttons are not a hierarchy.
- Prefer a single surface with rows for related choices; cards for separate destinations.
- Use secondary explanations where the decision happens. Keep connection limitations visible.
- White space separates groups; it should not delay the content behind oversized heroes.

## Tokens

`packages/design-tokens/tokens.css` is shared with onboarding and remains the source
of truth. Changes to colours, radii, shadows and type belong there.

- Canvas `#f7f8f6`, white surface, ink `#222523`, secondary ink `#626962`.
- Violet `#5433eb`, tint `#efecfe`. Use the accent for a selected action, brand,
  and meaningful state. Do not paint every available choice violet.
- Control radius 12px; groups 20px; pills for badges and small chips.
- Hairline separators and faint shadows. Hover may lift an actual clickable tile 2px.
- Inter/system sans. Main titles 32px/500; start greeting 32–44px/500;
  section headings 18px/500; body 16px; labels 14px; metadata 13px.
- Tight title tracking, generous body line-height, readable contrast.

## Navigation and layout

Desktop uses a 208px labelled sidebar. A small wordmark sits above Start, Rum,
Kalender and Godkänn. Fråga, Dina AI:er and Konto form a quieter secondary group.
Content is centered within a maximum 1120px area, with responsive horizontal padding.
The active location uses a restrained surface and clear text.

At 720px and below, the sidebar becomes five bottom controls: Start, Rum, Kalender,
Godkänn, Mer. The first four never move in response to state. Pending approvals stay
visible on Godkänn. Mer reveals Fråga, Dina AI:er and Konto; it reflects the current
secondary route, closes after navigation/outside click/Escape, and restores keyboard
focus on Escape. The small wordmark moves above the mobile page.

Provide a skip-to-content link, a real main landmark, visible focus, 44px main action
and navigation targets, and room above the bottom safe area. Verify at 320px CSS width.

## Start

A single list of chat apps replaces four competing launch cards. Each row contains a
quiet monogram, name, actual verification state, compact Connect/Open action, and direct
connection/help disclosures. The device's last chosen app may receive the violet
button. Do not invent a favourite for a first visit. Reordering happens on the next
visit, so a click does not move its own target.

Opening an app does not establish a connection. ChatGPT's required per-chat selection
stays beside its launch. Historical deliveries never imply the next chat is connected.
Errors are different from missing verification. Without a receipt, Connect goes directly
to the supported setup destination and opens the short guide on this page. For clients
needing a pasted URL, the visible hint explains that the same click copies the public
server address. Chat launch never writes to the clipboard. A blocked clipboard exposes
a selectable URL. Previously verified apps keep their direct Open action. No long
starter prompt or fake success state is introduced.

Observation starts with setup/launch and checks again on return; do not require a
separate verification click in the normal path. Keep manual commands and diagnostics
under additional help. The external client's consent and per-chat tool activation
remain visible where required; a design change cannot remove that provider boundary.

Below the launcher, three quiet destinations lead to personal memory, rooms and the
calendar. Memory-sharing preferences stay optional, with the existing explicit review
before anything becomes a memory.

## Rooms and memory

The personal room is first in the room list, lightly tinted, and never archivable.
Compact shared cards show title, concise description, members and unseen counts.
Headers introduce content without becoming landing-page heroes. The personal header
keeps identity and memory capacity together. Memory sections form readable shelves;
empty sections use quiet placeholders. IDs, provenance, inline editing and reversible
removal remain available.

Shared rooms remain reading surfaces. Never hide authorship, room visibility, conflicts,
or decisions to make a screen cleaner. Approval detail remains visible when required.

## Calendar

Use chronological rows with a subtle connecting line and small event marks. Time,
action, author and room support the memory text. Contributions from other people remain
clearly grouped, including the explanation and visibility information. The calendar
shows memory events; do not imply it is a complete external schedule.

## Motion and accessibility

Keep motion short (200–260ms), respect reduced motion, and avoid decorative repeated
pulsing. Use semantic links for navigation, buttons for actions and disclosures for
optional setup. A tidy first view must not make necessary actions inaccessible.

## Tone

Swedish, warm and direct. Specific client names when helpful. No invented emotional
state, familiarity, completed plans or automatic connection. The UI can invite a
conversation without performing a conversation it has not had.

## Review decisions

GPT-5.5 independently identified competing launch cards, repetitive setup copy,
crowded mobile navigation and a log-like calendar. We chose a unified launcher,
labelled desktop navigation and four stable mobile destinations plus Mer. We rejected
an arbitrary default favourite and dynamic swapping of mobile tabs. Follow-up review
caught the missing active state for Mer on secondary routes; that was corrected.
