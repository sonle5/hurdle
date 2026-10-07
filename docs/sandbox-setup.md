# Configure sandbox and storage

Configure E2B in the directory containing your evaluation:

```sh
npx hurdle setup --yes
npx hurdle run --view
```

`setup` validates the Suite, reads configured credentials, checks authentication
without inference, and saves the project Runtime. It reuses an available Hurdle
template; `--yes` explicitly accepts building a missing default template, which
may be billed. No evaluation or Agent runs during setup. Setup never prompts by
default, even in a terminal. Missing credentials or required build acceptance
produce an actionable error and a nonzero exit code. E2B is the default sandbox
provider; `--sandbox e2b` selects it explicitly. Other providers are not supported yet.

## Try visible Together API activity

In an empty project directory:

```sh
npx hurdle init --example together-api
npx hurdle setup --yes
npx hurdle run --view
```

The Agent looks up Together models, makes one small completion, saves the JSON
response, and summarizes its reply and token usage. The Viewer displays captured
HTTP activity alongside the transcript, code checks, and `completion.json`. The Suite
requires E2B's trusted HTTP capture, so a Native Local runtime cannot score it.

Configure `E2B_API_KEY`, `TOGETHER_API_KEY`, and Agent credentials in `.env.local`
or export them before setup. Exported values are not copied into the file.
Setup adds `.env.local`, `.hurdle/`, and legacy `.tae/` to `.gitignore` when
configuration succeeds. For the same variable name, file values override exports; a blank
assignment overrides a working exported value too. Use `--interactive` explicitly
for hidden credential prompts and a template-build confirmation in a terminal;
prompted values are saved with private file permissions after readiness and
any required build acceptance, before the build starts.

Claude Code uses `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`; Codex uses
`CODEX_ACCESS_TOKEN`, `CODEX_API_KEY`, or `OPENAI_API_KEY`. Use
`init --example together-api --agent codex` for a Codex demo. Setup's default
template includes the Agent CLIs selected by the Suite, plus Node 22, Python 3,
curl, jq, git, and iproute2. Credentials are never baked into the image.

## Reuse a template or automate setup

```sh
npx hurdle setup --template my-agent-template:v1
```

The selected template must already be available and contain the Suite's Agent
CLIs. Setup reads template access, build status, and capacity without allocating
a sandbox. A new Runtime adopts the existing template's capacity; a saved
Runtime must match it. Remote CLI installation is checked during execution.
A new Hurdle template uses 2 CPUs and 2048 MB.

Configure all credentials first. To accept building a missing default template:

```sh
npx hurdle setup --yes
```

Template builds use your E2B account and may be billed. Rerunning setup reuses
an available template, preserves the existing Result Store, Judge, Viewer, and
runtime limits, and repeats read-only readiness checks. Failed or declined
builds do not activate a new project Runtime.

## Automate setup

Agents and scripts can consume one JSON document on stdout:

```sh
npx hurdle setup --yes --json
npx hurdle setup --store postgres --json
```

Credentials come from `.env.local` or the environment; no credential values are
accepted as command-line arguments or emitted in the report. `--json` disables
terminal formatting and progress output, and cannot be combined with `--interactive`.
The result includes `schemaVersion`, `command`, `target`, `ok`, `exitCode`,
`requiredCredentials`, `missingCredentials`, `checks`, `runtimePath`,
`executionEnvironment`, `resultStore`, `nextCommands`, and `error`.
Each credential requirement has a `label` and `anyOf` list of environment
variable names. `error` is null on success or an object with a stable `code` and
safe `message`. Missing credentials are reported together before any provider
checks or resource creation. Exit codes are 0 for success, 1 for setup failure,
and 2 for invalid arguments.

Without `--yes`, a missing E2B template returns `setup.build-required` and a next
command accepting the build usage; no build is started. Existing templates do
not require `--yes`. Postgres setup needs no build acceptance: selecting
`--store postgres` explicitly requests applying the versioned schema migrations.

Optional terminal prompts:

```sh
npx hurdle setup --interactive
npx hurdle setup --store postgres --interactive
```

## Project defaults and overrides

Setup writes `.hurdle/runtime/default.json`. `validate`, `run`, and `view` discover
it automatically. An explicit `--runtime FILE` selects another Runtime;
explicit run topology options (`--environment`, `--environment-settings`, or
`--store`) select that topology instead of the saved default. To run locally:

```sh
npx hurdle run --environment local
```

Existing `.tae/runtime/default.json` profiles are still discovered and reused
by setup. Their configured Result Stores stay in place. If both directories
contain a default Runtime, `.hurdle/runtime/default.json` takes precedence.
Without a saved Runtime, local runs and the Viewer reuse `.tae/results-v1`
when it exists and `.hurdle/results-v1` does not. Explicit paths always apply.

Use `setup path/to/another.suite.mjs` when the Suite has a different filename;
the saved default applies to this project, and the Suite argument still selects
the evaluation for subsequent commands. `validate --offline` checks only Suite
definitions; it does not establish sandbox readiness.

New Runtime profiles use a local Result Store at `.hurdle/e2b-results-v1` and Viewer
port 3000. Each evaluation allocates an Agent sandbox and a Guardian sandbox,
each limited to five minutes by the starter Runtime. This is a lifetime limit,
not a dollar or token budget. Agent and Together inference may also be billed.
Model access, billing readiness, remote tools, and task success are checked when
the evaluation actually runs. Existing configured limits are not shortened.

## Use Postgres for results

Connect an existing Postgres database, such as Neon, from your evaluation project:

```sh
npx hurdle setup --store postgres
npx hurdle validate
npx hurdle run --view
```

Set `HURDLE_RESULT_STORE_DATABASE_URL` in `.env.local` or the environment before
setup. Legacy credentials and unmodified Runtime profiles remain supported.
Successful Postgres setup updates the built-in `TAE_RESULT_STORE_DATABASE_URL`
credential name to `HURDLE_RESULT_STORE_DATABASE_URL`; custom names are preserved.
The Hurdle variable takes precedence whenever present, including an empty value;
the legacy alias is used only when it is absent. For the same variable name,
`.env.local` overrides the shell.

Setup reports the variable name when it is missing; `--interactive` explicitly
enables hidden input in a terminal. It checks the connection, applies the
versioned migrations for the `hurdle` schema, and saves the project default. The
database must already exist, and the connection must permit creating the schema
and its tables. An upgrade requires schema ownership and permission to rename
it. Rerunning setup verifies existing migration checksums and applies only
missing migrations. No Agent runs or E2B resources are created.

For an existing database, setup transactionally renames `tae` to `hurdle`,
preserving Run rows, captured evidence, migration history, ownership, and grants.
Fresh databases finish with the `hurdle` schema. If both schemas already exist,
setup refuses without changes instead of merging or dropping either schema.
Stop existing run, Viewer, and setup processes and use the updated Hurdle version
consistently before upgrading. Clients at `0.2.4` or earlier expect `tae` and can
recreate it during setup. Update external SQL and `search_path` settings from
`tae` to `hurdle`. Legacy environment variables remain supported; `validate`,
`run`, and the Viewer never apply database migrations.

Storage setup preserves your Local or E2B execution environment, Judge settings,
and Viewer port. Without a saved Runtime, it configures Local execution. To use
E2B and Postgres, run `npx hurdle setup --yes` first, then `npx hurdle setup --store postgres`.
Configure sandbox and storage in separate commands; sandbox flags do not apply
to storage setup. Subsequent `validate`, `run`, and `view` discover the saved
storage configuration automatically.

Existing filesystem results stay in place; this does not import them into
Postgres. Run records and captured evidence go to the database, while output
artifact bytes stay in `.hurdle/postgres-artifacts`. Existing Postgres profiles
retain their custom credential name and artifact directory. Prompted credentials
use the same private `.env.local` handling as sandbox setup, and database URLs
are never printed. Failed connection or migration checks leave the active Runtime
unchanged. The connection URL is stored only as a credential, never in the Runtime.

Template recipe: [E2B's SDK workflow](https://docs.e2b.dev/template/quickstart).
