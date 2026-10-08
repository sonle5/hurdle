# Together API starter

One Agent looks up Together models, makes one short chat completion, saves
`completion.json`, and summarizes the reply and token usage. Open the saved
response and captured HTTP activity in the Results Viewer.

```sh
npx hurdle setup --yes
npx hurdle run --view
```

Set `E2B_API_KEY`, `TOGETHER_API_KEY`, and Agent credentials in `.env.local`
or your shell before setup. Setup reports missing credentials without prompting;
use `setup --interactive` for credential prompts and build approval.
Keep `.env.local` out of version control. `--yes` accepts building an E2B
template; it checks authentication through read-only requests and never runs
inference or the evaluation. Remote tools and model access remain unverified
until the run.

The starter pins `claude-opus-5-5` with `effort: "medium"`. Use
`init --example together-api --agent codex` for `gpt-6.1-sol` with medium effort.
Use `init --model MODEL --effort LEVEL` or edit the Suite to change these settings.

The Suite uses one task, one baseline condition, and one repeat, with code
scoring and no Judge. The runtime created by setup uses two sandboxes, each with
a five-minute lifetime limit. Existing runtime limits are preserved on reruns.
Agent, E2B, and Together usage may be billed.

The prompt instructs the Agent to make one model-list call and one completion
call with at most 32 generated tokens and no retries. Those instructions are not
a hard spending cap: the Agent could make additional calls. A required code
check rejects extra completion attempts after execution. Edit
`fixtures/request.json` to try another model.

The checks require trusted, successful GET /v1/models and POST
/v1/chat/completions evidence. Native Local cannot supply that evidence. Artifact
checks verify that the saved response includes a reply and token usage. HTTP
metadata proves
the requests occurred, but does not prove the exact request body or response
contents. Artifacts remain Agent-produced evidence.

API references: [model catalog](https://docs.together.ai/reference/models) and
[chat completions](https://docs.together.ai/reference/chat-completions).
