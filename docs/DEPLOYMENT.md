# Deployment and isolated testing

This guide describes a fresh, self-hosted installation. It does not migrate the author's production data or provision a hosted backend for a fork.

## Local configuration

Use Node.js 22.13+, Docker with Compose, and the committed lockfiles.

```sh
node scripts/setup-local.cjs
```

Setup preserves existing files and creates `docker/.env` with random database/JWT secrets, `backend/.env` from the server example, and `.local/admin-bootstrap.env` for bootstrap. These files stay outside Git.

Fill in the model keys you intend to use. The default assistant uses Qwen via `DASHSCOPE_API_KEY`; indexing also needs `EMBEDDING_API_KEY`. DeepSeek is disabled in the supplied Docker configuration. Provider endpoints and keys stay on the server. Never use real keys in frontend `VITE_*` variables.

## Inspect and start

```sh
node scripts/chatforum-compose.cjs production plan
node scripts/chatforum-compose.cjs production up
node scripts/bootstrap-local.cjs
node scripts/chatforum-compose.cjs production ps
```

The helper combines the base application, forum-search, and forum-scale Compose files. It preserves an existing fourth artifact-review overlay. Startup applies committed Prisma migrations without seeding or re-importing users. Bootstrap preserves existing accounts; read initial credentials from your local bootstrap file.

| Entry | Local address |
| --- | --- |
| Application | http://127.0.0.1:8080 |
| Separate administration | http://127.0.0.1:8091 |
| Process health | http://127.0.0.1:8080/api/health/live |
| Dependency readiness | http://127.0.0.1:8080/api/health/ready |

Keep the administrator host mapping on loopback, outside public reverse proxies, and retain its Host, Origin, and CSRF checks. The default volume namespace is `chatforum-next`; inspect existing containers and volumes before sharing it with another installation. Back up persistent data before upgrades. Do not use `down -v` or `migrate reset` as a routine update step.

## Documents and indexes

Create your own private knowledge base, upload authorized material, and build a new index. Wait for validation and READY before explicitly publishing it; preserve the old index until the new version is confirmed. No novel corpus, initialized vector collection, or production database ships with this repository.

Processing may send authorized text to configured embedding/model providers. Multi-host installations need shared source-file storage as well as a shared database. Current ACLs protect retrieval, final delivery, and source access.

## Public access and Pages

Put the application behind HTTPS and configure its public CORS origin. Keep MySQL, Redis, Qdrant, OpenSearch, and administration private. The supplied loopback mappings do not expose a server to the internet.

GitHub Pages hosts only the frontend. Use `VITE_PAGES=true`, the correct `VITE_BASE_PATH`, and a public HTTPS `VITE_API_BASE_URL` ending in `/api` at build time. Missing/invalid API configuration intentionally fails the Pages build. The backend remains online separately; visitors should not have to enter an arbitrary API endpoint.

## Optional offline HTML review

Review uses a separate private queue and host operator. It is opt-in and is not required for downloading a generated file. Inspect `docker/compose.artifact-review.yml` and `scripts/artifact-review-daemon.cjs` before enabling it:

```sh
node scripts/chatforum-compose.cjs production plan --artifact-review
```

Keep the original three overlays when adding the fourth. Never give the public API a Docker socket or shell. The isolated renderer is non-root, network-disabled, read-only, and retains Chromium sandboxing. Reports/screenshots remain private. No startup service is automatically installed.

## Isolated tests

```sh
node scripts/chatforum-compose.cjs rag-test plan
node scripts/chatforum-compose.cjs rag-test up
```

Use only disposable `chatforum_test` services from `docker/compose.test.yml`. Set `RUN_RAG_INTEGRATION=1` deliberately; other integration suites have separate opt-in flags. Never inherit a production database URL. Native Linux attachment parsing/export needs CJK fonts, which are present in the Docker image.

The forum-search test project uses separate port 39201:

```sh
node scripts/chatforum-compose.cjs search-test plan
```

Production search uses loopback port 39200. Tests must not remove or repurpose production volumes.

Review schema changes, build both applications, and validate affected contracts before any live upgrade. A push or pull-request merge does not authorize deployment. See [contribution rules](../CONTRIBUTING.md), [security boundaries](../SECURITY.md), and [evaluation guidance](../backend/eval/README.md).
