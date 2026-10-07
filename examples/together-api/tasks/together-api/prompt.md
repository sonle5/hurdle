Call Together's API and report what happened:

1. GET /v1/models and confirm the model in fixtures/request.json is available.
2. POST /v1/chat/completions with fixtures/request.json unchanged. Save the real
   response as completion.json at the workspace root.
3. In your final reply, include the generated text and reported token usage.

Use https://api.together.ai and TOGETHER_API_KEY as the Bearer credential;
never print or save the key. Make one call per endpoint, with no extra API calls
or retries. Use a 30-second request timeout, fail on HTTP errors, and avoid
redirects. If a request fails or the model is unavailable, stop and explain it.
