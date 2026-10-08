# Copy a message

A product-neutral code-checked Task. It needs the selected Agent's authentication,
but no Together key, Judge, database or sandbox account. The default Claude
starter pins `claude-opus-5-5` with `effort: "medium"`. Use `hurdle init --agent codex` for
a starter pinned to `gpt-6.1-sol` with medium effort, and provide its authentication.
Use `init --model MODEL --effort LEVEL` or edit the Suite to change these settings.

The agent reads `fixtures/message.txt` and writes its exact contents into
`answer.txt`. A successful run shows `Passed` and opens the results viewer.

Install the selected agent CLI and provide explicit authentication in your
project's `.env.local`. For Claude Code, use a valid `ANTHROPIC_API_KEY`, or run
`claude setup-token` and set `CLAUDE_CODE_OAUTH_TOKEN` to the generated token.
An API key takes precedence if both are set. For Codex, set `CODEX_ACCESS_TOKEN`,
`CODEX_API_KEY`, or `OPENAI_API_KEY` (in that order of precedence).
Hurdle uses isolated agent configuration and does not inherit your interactive
agent login. Keep `.env.local` out of version control.

From your project directory after creating the default `evals/` starter:

```sh
npx hurdle validate
npx hurdle run --view
```
Validation checks the Suite, installed local agent, and required credentials.
API keys receive a read-only authentication check; no inference is requested.
Subscription tokens are reported as configured, with live validity unverified.
Model access, credits, and task success still depend on the actual run. `run`
repeats readiness checks before opening the result store or launching an agent.
Use `npx hurdle validate --offline` to check only the definition without network
or agent installation checks.

The Suite defines the matrix; `--task`, `--condition`, `--agent` and `--model`
only filter existing selections. This starter runs once; set `repeats` in the
Suite to run independent repeats.

Local execution runs code on your host with network access; it is not a security
sandbox. Use only trusted Suites, checks and task inputs.
