// Subprocess CLI fixtures authenticate against this hermetic read-only probe.
// Agent subprocesses do not inherit NODE_OPTIONS or this hook.
globalThis.fetch = async (url, options) => {
  if (options?.method !== "GET" || ![
    "https://api.anthropic.com/v1/models?limit=1",
    "https://api.openai.com/v1/models",
    "https://api.together.ai/v1/models",
  ].includes(url)) throw new Error("Unexpected network request in CLI fixture");
  return new Response(JSON.stringify({ data: [] }), {
    status: process.env.HURDLE_TEST_AUTH_REJECT === "1" ? 401 : 200,
    headers: { "content-type": "application/json" },
  });
};
