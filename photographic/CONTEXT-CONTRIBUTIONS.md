# Context that follows the person

Photographic first asks a connected AI to read the current context, then compare all
user context actually available to that AI. This precedes onboarding questions or
suggesting another data source. It does not imply access to the provider's entire
account history, files, mail or another app's memory.

## User flow

1. Start from `/chatt`, without choosing a room. The native launch behavior remains in
   `@photographic/connect`; current provider limitations are documented in CHAT-START.md.
2. Read `get_context`, including the shared contribution pause/pending state. When paused
   or another review is pending, continue the conversation without another offer.
3. Use `prepare_context` for all available new facts, in chunks of up to 20 with a common
   `batch_id`. Finish the chunks before making one offer. An interrupted chunk can be
   retried; an existing unfinished batch can continue without another offer unless paused.
4. The tool creates a **private review draft**, not accepted memory. Preparing it transfers
   candidate content to Photographic. The AI must explain this, and ask before sensitive
   transfer or accessing a new external source. It must never claim to have transferred
   unseen history. Content originating in Photographic and recognizable credentials are
   excluded. The secret filter is defense in depth, not an exhaustive classifier.
5. `/godkann` groups the proposed additions. Ordinary facts are selected for one bulk
   approval. Sensitive facts, claims about others, inferences, instructions and conflicts
   require individual selection. Source, observation time when supplied, and conflicting
   text are shown. Inferences stay labeled as unconfirmed notes in memory.
6. Only the person's first-party session can accept, dismiss or resume. MCP has no accept
   or resume action. `Inte nu` retains the draft and pauses new offers across clients;
   dismissal also pauses, and the dismissed content is suppressed after explicit resume.
   A collapsed control on Start and Godkänn lets the person resume without recurring popups.
7. Approved facts retain the originating client/session and the human approval in history.
   They enter the personal room, then the existing profile/context pipeline. A shared-room
   conflict never changes a shared item through this flow. No external file/mail/Slack
   connector is installed by these changes. Once comparison is complete, AI instructions
   allow at most one relevant question or source suggestion, never an onboarding checklist.

The first-response guidance now uses a natural, name-grounded greeting after a fresh
context read. A new-fact offer shows up to three concrete examples with the complete
review behind its link. An empty personal profile does not imply empty shared rooms;
read failures are not new-user signals. See CHAT-START.md for the remaining native
app activation/first-turn limitation: hidden connection guidance is not auto-send.

## Comparison and failure behavior

- Comparison uses full accessible active item bodies and prior contribution proposals,
  not the token-limited profile. Permission and OAuth room scope apply inside PostgreSQL
  reads. Exact duplicates are removed first; embeddings shortlist up to eight neighbors
  for semantic comparisons. This is approximate matching, not proof of perfect recall.
- All comparisons for a chunk finish before proposals are written. PostgreSQL commits the
  chunk in one transaction. Provider errors leave the chunk retryable. Malformed/empty
  embedding results fail closed.
- Preparation and approvals serialize per personal room (database advisory transaction
  lock, or memory-driver mutex). Each accepted proposal and its item/events commit
  together. Retrying an accepted ID cannot create another item. Ordinary memory writes
  retain their existing concurrency rules; exact uniqueness still applies.
- Approval repeats the comparison against current memory. Newly changed conflicts update
  the draft and require another review. The browser sends the displayed reason with its
  selection, and it is checked under the lock: another tab cannot silently approve a
  refreshed conflict with old consent.
- Bulk results distinguish saved, dismissed, already handled, needs review and failed.
  Successful entries leave the queue; failed entries stay. The UI splits batches larger
  than 100 into requests and retries safely after an interrupted response.
- A report that confirms an earlier inference requires fresh review before replacing it;
  semantic similarity does not keep an unconfirmed interpretation forever.
- Context from Photographic is not fresh independent evidence. Accepted/rejected past
  proposals also prevent an AI from reintroducing a deliberately forgotten contribution.
  Correcting a previously rejected claim can still be requested explicitly through the
  existing memory editing flow.
- Drafts use the existing proposal/event retention and account export/deletion behavior.
  Accepted item metadata keeps source fields but does not duplicate raw candidate or
  conflicting text. This feature does not create a new general-purpose document archive.

## Implementation and verification

One new MCP tool (`prepare_context`, ten total), four IngestPort operations shared by
both drivers, and migration `0025_context_contributions.sql` for one person-level pause
preference. Existing proposals, approval records, item provenance and projections do the
rest. Tool-description budget is now 5,500 tokens to include the structured batch schema.

The contribution acceptance suite runs on both memory and PostgreSQL in CI. It covers
cross-client handoff, source provenance, selective approval, global pause, rejected and
deleted-offer suppression, semantic deduplication, retries/concurrent approval, refreshed
conflicts, stale browser consent, and account/room-scope isolation. Additional checks
cover comparison outages, invalid embeddings, real MCP SDK transport/schema, first-party
REST boundaries and browser selection/pause/large-batch behavior. External AI providers'
choices and private memory availability cannot be established by deterministic tests.
