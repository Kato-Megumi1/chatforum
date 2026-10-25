# Public release scope

The initial public release is a source-only snapshot of ChatForum. It includes the backend, frontend, lockfiles, schema, all 24 database migrations, Docker configuration, tests, and portable setup scripts.

The following are outside the public repository:

- Private repository history and machine-specific agent instructions.
- Real environment files, model keys, authentication tokens, SMTP configuration, and bootstrap credentials.
- Production databases, import ledgers, account migrations, uploaded files, novel text, and vector collections.
- Private evaluation questions, raw answer exports, screenshots, backups, and deployment evidence.
- The obsolete destructive demo seed and its fixed demo passwords; bootstrap is the supported setup path.
- Unused full-resolution login-background source files; the application uses its existing optimized asset.

The application source is otherwise retained. The public snapshot updates documentation and package licensing metadata, removes obsolete seed commands, and does not deploy or alter the owner's running services.

The owner-provided walkthrough is hosted by the personal GitHub Pages site and linked from the README. That media is not a substitute for an accuracy evaluation or load test.
