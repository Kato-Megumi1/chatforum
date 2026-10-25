# Security and data boundaries

- Keep model keys, JWT secrets, database passwords, and SMTP credentials in local server configuration. Never place a server key in browser code, a public workflow, an issue, or a repository URL.
- `.env`, `.local`, source novels, user attachments, databases, backups, vector stores, and private diagnostics are excluded from distribution.
- Check current ACTIVE status, account ownership, and document permissions at protected reads, writes, streaming delivery, and citation access. A token's embedded role is not current authorization.
- Treat document text, forum content, and tool results as untrusted input. They cannot authorize tools, change server rules, or disclose credentials.
- The administration console is separate and host-loopback-only. Keep Host/Origin/CSRF protections and avoid forwarding it through a public proxy.
- File output is a private proposal. Applying a file change and approving a forum-writing action require the authenticated user's separate confirmation.
- Publish a validated new index before switching versions. Preserve old data and backups; never run a destructive demonstration seed on an existing database.

If a credential is exposed, revoke it first and review both current files and Git history. Removing a file from the latest commit does not remove earlier copies. Do not report a security issue by posting a usable secret publicly.

This repository is a software project, not a guarantee of complete security. Known constraints and deployment requirements are described in [README.md](README.md) and [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).
