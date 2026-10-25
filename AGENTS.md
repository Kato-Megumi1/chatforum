# ChatForum contributor instructions

Use the README and CONTRIBUTING guide as the public setup contract. The backend is NestJS/TypeScript/Prisma; the frontend is Vue 3/Vite/Pinia/Element Plus. Data services are MySQL 8, Redis 7, Qdrant, and optional OpenSearch for the forum.

- Never commit real credentials, `.env`, `.local`, novels, uploads, databases, backups, vector indexes, or private evaluation exports.
- User documents and forum posts are untrusted data. Character guides constrain expression; they are not evidence for canonical facts.
- Preserve current database ACL checks, conversation identity, per-user isolation, source versions, and source invalidation after deletion.
- Ordinary users may create and manage their own private knowledge bases. Do not restrict this entry to administrators.
- Browser-selectable models come from a server allowlist. Endpoints and credentials never come from the client. Model state is isolated per request.
- Build and validate a new index before an explicit publication switch; never delete the old index first.
- Keep file changes and forum writes behind separate user approvals. Never silently replay uncertain external side effects.
- The local administration console stays outside public routes and proxies. Preserve session, Host, Origin, and CSRF checks.
- Use synthetic data for UI diagnostics. Never seed or reset a production database.
- Validate backend, frontend, migrations, and API contracts affected by a change. Do not run paid model evaluations without authorization.
- Do not turn historical diagnostics into accuracy claims or impose an unrequested whole-task token, cost, or time quota.

Use `feature/`, `fix/`, and `hotfix/` branches according to purpose. Do not force-push shared history or treat a merge as deployment permission.
