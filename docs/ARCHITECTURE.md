# Architecture

ChatForum shares one web application across an ordinary assistant, a separately identified character dialogue service, and a community forum. Server-side identity and ownership control which capabilities each conversation can use.

## Conversation delivery

The API accepts an idempotent chat run and stores it in MySQL. A leased worker prepares authorized history, resolves the server model allowlist, and records provider usage. SSE readers receive public progress and final text, resume by offset, and recheck current user access. Raw model reasoning, private drafts, and internal tool parameters are not public progress.

Recent history is bounded by complete turns and context capacity. Older content is represented by source-linked excerpts. Memory caches are derived from messages, not an independent truth store; source deletion or sharing changes invalidate derived content. Cross-conversation memory is off by default and filters both source and target identity.

## Novel evidence

Canonical questions follow classification and rewriting, an ACL-filtered index snapshot, semantic retrieval in Qdrant and Chinese lexical retrieval in MySQL, reciprocal-rank fusion, bounded scene evidence, reranking, adjacent context, evidence checks, character expression, and independent verification. Every retry stays on the same index version and question scope. Source access is checked again when a citation is opened.

Character expression and whether an answer actually addresses the question are separate checks. A chapter containing a quote is not automatically the time of the event; co-occurrence is not a relationship. An automatic verification state is not a human evaluation result.

## Tools and files

The ordinary assistant can read authorized attachments and create private file proposals. It does not obtain a host shell or Docker socket. Side-effecting forum actions need a separate user approval; a model-generated confirmation flag is insufficient. Persisted tool steps record receipts and uncertainty without claiming perfect exactly-once effects.

## Forum

Writes commit source content and outbox deliveries together. Workers maintain derived search and interaction views with leases, retries, and explicit dead-letter handling. Search candidates are revalidated against current SQL visibility and revision. Paging uses signed seek cursors; interaction snapshots are not a promise of real-time or million-user performance.

## Operational boundaries

Model credentials remain on the server. Document ACLs, current ACTIVE status, authentication version, conversation ownership, and source epochs protect delivery. Administration is a separate host-loopback entry. An optional offline HTML-review operator is isolated from the public API and is not enabled merely by running the default stack.
