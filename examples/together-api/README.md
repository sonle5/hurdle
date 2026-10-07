# Together API starter

One Agent looks up Together models, makes one short chat completion, saves
`completion.json`, and summarizes the reply and token usage. Open the saved
response and captured HTTP activity in the Results Viewer.

```sh
npx hurdle setup
npx hurdle run --view
```

Setup configures E2B and asks for E2B, Agent, and Together credentials when
missing. Keep `.env.local` out of version control. Setup may build an E2B
template; it checks authentication through read-only requests and never runs
inference or the evaluation. Remote tools and model access remain unverified
until the run.

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
