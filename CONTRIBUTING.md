# Contributing

Start from a small, reproducible problem. Use `feature/<topic>` for additions, `fix/<topic>` for corrections, and `hotfix/<topic>` only for urgent production fixes. Submit a pull request to `main`; a pull request does not authorize production deployment.

## Development

Use Node.js 22.13+, UTF-8, the checked-in lockfiles, and the setup steps in [README.md](README.md). Backend and frontend dependencies are installed independently. Avoid unrelated dependency upgrades and formatting churn.

Keep current database authorization, per-user isolation, model allowlists, private file proposals, explicit write approvals, and versioned index publication intact. Treat uploaded documents, forum posts, and model outputs as untrusted data.

## Validation

Run the checks relevant to the change:

```sh
npm run build
npm --prefix backend test -- --runInBand
npm --prefix frontend test
node --test scripts/chatforum-compose.spec.cjs
```

Database integration tests must use `docker/compose.test.yml` and its disposable `chatforum_test` database. Do not inherit a production `DATABASE_URL`, run migration reset against a real database, or seed existing content. Optional paid-model evaluations require a deliberate decision and authorized source material.

The `scripts/check-*.cjs` browser checks use synthetic users and intercepted APIs. Install root dependencies with `npm ci`, provide a local frontend preview, and use the script's documented environment variables. Do not capture real credentials or other users' conversations in diagnostics.

Before pushing, inspect staged paths and run:

```sh
node scripts/check-publication.cjs --staged
git diff --cached --stat
```

Never commit `.env`, `.local`, novels, uploads, databases, backups, vectors, or private evaluation output. Include migration and API-contract changes in the same pull request as the feature they support. Report what was actually tested and any material verification limit.
