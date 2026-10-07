# Local Hurdle experiments

Source-only helpers for previewing CLI headers and trying E2B integration.
Nothing in this directory is included in the npm package. Run these commands
from the repository root.

## Review the CLI and ASCII headers

```sh
node harness/experiments/preview-cli.mjs brand
node harness/experiments/preview-cli.mjs readiness
node harness/experiments/preview-cli.mjs view
```

Choose a single header with `brand 1`, `brand 2`, or `brand 3`. These are previews,
not an applied branding change. `readiness fail` previews rejection and recovery
text. Previews make no provider requests, run no agent, and start no server.

To try the draft against your existing quickstart project, run the source CLI
from that directory, replacing `/path/to/together-agent-evals` with your checkout:

```sh
node /path/to/together-agent-evals/harness/bin/hurdle.mjs validate
node /path/to/together-agent-evals/harness/bin/hurdle.mjs view
```

The CLI uses one line per authentication check, green/red/yellow status
symbols in a terminal, and a compact Viewer display. `NO_COLOR` disables color;
redirected output has no styling. Stop your existing Viewer before opening the
same store on port 3000.

## Prepare the E2B lab

Hurdle has a public `setup` command. For the Together API demo,
use a new project directory and run the source CLI from your checkout:

```sh
node /path/to/together-agent-evals/harness/bin/hurdle.mjs init --example together-api
node /path/to/together-agent-evals/harness/bin/hurdle.mjs setup --yes
node /path/to/together-agent-evals/harness/bin/hurdle.mjs run --view
```

Run each step separately and continue only after it succeeds. Configure the E2B,
Agent, and Together credentials in `.env.local` first. Setup checks credentials,
reuses a ready template or builds one with `--yes`, and saves the default Runtime
for later commands. Builds may be billed. Setup reports missing credentials
without prompting by default; use `--json` for automation or `--interactive` for
hidden terminal prompts. The source commands above use the version in this checkout.
See [sandbox setup](../../docs/sandbox-setup.md) for options and limits.

The earlier source-only lab helper remains available below.

To create a lab at `.hurdle/e2b-lab`, install optional E2B dependencies and prepare
it once:

```sh
npm run setup:backends
node harness/experiments/e2b-lab.mjs prepare
```

Preparation refuses to overwrite an existing experiment or its credentials.
To reuse an existing Claude Code template, use `prepare --template NAME`
instead and skip the template build. Its CPU/memory settings must match the
Runtime; the default recipe uses 2 CPUs and 2048 MB.

Add `E2B_API_KEY` and either `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` to
`.hurdle/e2b-lab/.env.local`, or use credentials already exported in your shell.
Use `.env.example` as a reference. Do not commit credentials. Values configured
in the lab's `.env.local` override shell values.

On this Mac, create and open the credentials file:

```sh
touch .hurdle/e2b-lab/.env.local
open -e .hurdle/e2b-lab/.env.local
```

Add `E2B_API_KEY=your-key` and save. Keep your working Anthropic credentials
exported, or add them to the file too. Only add keys you intend to configure;
an empty `ANTHROPIC_API_KEY=` would override a working exported key.

Run the following steps **one at a time**. Continue only when each succeeds.
Preview the template without contacting E2B:

```sh
node harness/experiments/e2b-lab.mjs template
```

The preview shows a short summary. Use `template --dockerfile` for the full
recipe. It installs Node 22, Python 3, iproute2, and Claude Code 2.1.288. Authentication
credentials are passed when running and are never baked into the template.
The SDK recipe follows [E2B's template workflow](https://docs.e2b.dev/template/quickstart).

Build the new `hurdle-claude-code-dev:v1` template explicitly:

```sh
node harness/experiments/e2b-lab.mjs template --build
```

The build uses E2B resources and may be billed. Wait for `Template ready`, then
validate:

```sh
node harness/experiments/e2b-lab.mjs validate
```

Validation checks API-key
and E2B account access using read-only requests; it allocates no sandbox.
Remote agent installation/model access are verified during execution. An
existing template's capacity should be checked against
`.hurdle/e2b-lab/.hurdle/runtime/e2b.json` before running.

After validation passes, run one `copy-message` evaluation and open its Viewer:

```sh
node harness/experiments/e2b-lab.mjs run --view
```

This command may incur Agent and E2B usage. It allocates two sandboxes (agent
and Guardian), each with a five-minute lifetime limit. This is a time limit,
not a dollar or token budget. There is one task/condition/repeat, no Judge, no
Together API task, and no Postgres requirement.

Results are stored in `.hurdle/e2b-lab/.hurdle/e2b-results-v1`.
The Viewer uses `http://127.0.0.1:3002`. Reopen it with:

```sh
node harness/experiments/e2b-lab.mjs view
```

## What to observe before designing the patch

- Can a new user understand template creation and credentials from these steps?
- Does read-only validation catch missing/invalid credentials without allocation?
- Does the configured template match the requested capacity and launch the CLI?
- Does the copy task pass, capture answer.txt, and dispose both sandboxes cleanly?
- How much time is spent on Guardian setup versus the Agent task?
- Does the new public `hurdle setup` command make this flow clearer?

The template has only been previewed locally. No template build or live E2B run
was performed during preparation. Keep any logs/results for triage before
retrying a failed run.
