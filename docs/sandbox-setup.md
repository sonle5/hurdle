# Set up a sandbox

Configure E2B in the directory containing your evaluation:

```sh
npx hurdle setup
npx hurdle run --view
```

`setup` validates the Suite, asks for missing credentials with hidden secret
input, checks authentication without inference, reuses an available Hurdle
template or asks before building one, and saves the project Runtime. No
evaluation or Agent runs during setup. E2B is the default sandbox provider;
`--sandbox e2b` selects it explicitly. Other providers are not supported yet.

## Try visible Together API activity

In an empty project directory:

```sh
npx hurdle init --example together-api
npx hurdle setup
npx hurdle run --view
```

The Agent looks up Together models, makes one small completion, saves the JSON
response, and summarizes its reply and token usage. The Viewer displays captured
HTTP activity alongside the transcript, code checks, and `completion.json`. The Suite
requires E2B's trusted HTTP capture, so a Native Local runtime cannot score it.

Configure `E2B_API_KEY`, `TOGETHER_API_KEY`, and Agent credentials in `.env.local`
or export them before setup. Missing values are prompted in an interactive
terminal; exported values are not copied into the file. New prompted values
are written with private file permissions after readiness passes, and setup
adds `.env.local`, `.hurdle/`, and legacy `.tae/` to `.gitignore`. Existing file
values override exports; a blank assignment overrides a working exported value too.

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

In a noninteractive shell, configure all credentials first. To accept building
a missing default template without the confirmation prompt:

```sh
npx hurdle setup --yes
```

Template builds use your E2B account and may be billed. Rerunning setup reuses
an available template, preserves the existing Result Store, Judge, Viewer, and
runtime limits, and repeats read-only readiness checks. Failed or declined
builds do not activate a new project Runtime.

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

Template recipe: [E2B's SDK workflow](https://docs.e2b.dev/template/quickstart).
