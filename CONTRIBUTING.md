# Contributing

Thanks for helping improve Together Agent Evals.

## Set up the repository

Use Node.js 22.13 or newer, then install the locked development dependencies:

```sh
npm run setup:ci
```

Native Local execution runs evaluated Agent code on your host and is not a
security sandbox. Only run Suites and task inputs you trust. Do not commit API
keys, local Runtime files, Result Stores or generated Agent workspaces.

## Make a change

Create an issue for substantive work, then branch from the latest `main`:

```sh
git switch main
git pull --ff-only
git switch -c codex/<issue>-<short-name>
```

Keep changes focused. Public evaluation authoring should use Suite modules and
Task folders; do not add a second configuration surface.

Do not weaken Run Trust, evidence custody and redaction, cancellation, cleanup,
or disposal safeguards to make an evaluation pass.

## Verify the change

Run the bill-free checks and Viewer build:

```sh
npm test
npm run build
```

These commands must not call paid Agent, Judge, E2B or Together services. If a
live evaluation is genuinely needed, describe its scope and spending bound in
the pull request before running it.

Open a pull request against `main` and include the user-visible effect, test
evidence and any security or compatibility tradeoffs. Keep `main` releasable;
accepted pull requests are squash-merged.

Security reports should follow [SECURITY.md](SECURITY.md), not a public issue.
