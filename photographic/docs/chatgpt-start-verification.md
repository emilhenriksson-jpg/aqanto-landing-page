# ChatGPT conversation activation — updated 2026-09-24

## Latest correction: selection is not a startup task

The native conversation titled “Välkommen till Photographic” greeted the person and
confirmed tool availability, but prepared a proposal only after an explicit request
to upload known context. The earlier successful web greeting test was not enough
to establish reliable native behavior. The person then approved the import;
subsequent live reads confirmed profile facts and five private project rooms.

Desktop launch now prefills the selected app **and** this short visible request:
“Läs mitt minne och föreslå relevant information och rum som saknas, utifrån det du
redan vet om mig.” The person sends it once. It is not hidden, automatic submission,
or authorization to save proposed memories. No personal context goes in the URL.

The first 512 characters of shared startup guidance now contain the read, compare,
propose and approval sequence. Pending proposals no longer imply that the person
has already seen them: reuse their review instead of duplicating the import or
silencing the first offer. Explicit pauses still suppress offers, and an already
shown offer, silence, a topic change or an ongoing task must not trigger reminders.
This is model guidance, not server knowledge of whether an offer was displayed.

Unit/integration tests cover launch content, account isolation, pending-versus-paused
guidance, approval boundaries and the instruction budget. They do not prove native
model initiative. Native composer behavior and mobile remain separate acceptance
checks; an app-only greeting is no longer the supported desktop startup contract.

## Observed provider behavior

The reported ChatGPT Instant conversation replied to `hej` and `har du photografic`
without a visible tool call. Saying the connection exists did not establish that
the conversation had read Photographic.

In a separate real ChatGPT test, **Try in chat** on the connected private app
inserted a Photographic mention. Sending that mention with `hej` read the profile
and attempted `prepare_context`, including useful private project rooms. ChatGPT
then required data-transfer approval. That write was declined for the test; no
test import was approved or saved. The final response confirmed the profile read
and reported the declined proposal truthfully.

This establishes activation with explicit app selection in ChatGPT web. It does
not establish automatic selection in a blank chat, native Mac handoff, mobile
handoff, or approval-free transfers.

## Desktop launch change

The account owner can save the link to their existing private Photographic app
under the connection guide once. Store its normalized plugin ID on their own
active ChatGPT OAuth grant. Never infer it from another person's grant, put one
user's development app ID in a public default, or treat a stored ID as delivery.
Connected AIs cannot modify the binding through OAuth.

The native launch remains `codex://threads/new?mode=chat`. A bound account adds
a `prompt` containing `[@Photographic](plugin://<verified-private-app-id>)` followed
by the visible read-and-propose request above. No profile, credentials, room
selection or project goes in the URL. Missing, invalid,
revoked or unavailable bindings retain the ordinary launch and selection guide.

Private-app ID syntax was observed in ChatGPT's rendered mention DOM. This is
provider-specific compatibility code, not a publicly registered Photographic
plugin. An installed app might be unavailable under another ChatGPT account;
provider UI handles that case. Mobile links are unchanged because the native
desktop mention route does not establish mobile support.

## Acceptance cases

| Case | Evidence / expected result |
| --- | --- |
| Blank conversation, `hej` → `har du photografic` | Reported failure reproduced by inspecting the exact conversation: no calls |
| Photographic selected, `hej` | Real web run reads context and attempts a relevant room/memory proposal |
| Provider requests data-transfer approval | Keep the provider's approval; never silently bypass it |
| Bound account opens desktop chat | Link contains the account's plugin mention, short startup request and explicit Chat mode; no auto-send |
| Different person using the same OAuth client | SQL isolation keeps bindings separate |
| AI token attempts to change launch binding | Refused even with memory write permissions |
| Revoked grant | Binding cannot be changed or used for launch |
| Mobile | Existing honest manual-selection instruction remains |

Mac composer rendering and physical mobile flows still need provider-level
verification. Unit tests on URL construction are not evidence of a model run.

Sources:
- https://learn.chatgpt.com/docs/reference/commands#start-a-task-with-a-plugin
- https://developers.openai.com/plugins/guides/optimize-metadata
