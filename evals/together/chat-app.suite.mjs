import { defineSuite } from "tae";

export default defineSuite({
  api: {
    authorizationCredential: "TOGETHER_API_KEY",
    hosts: ["api.together.ai", "api.together.xyz"],
  },
  tasks: ["./tasks/chat-app"],
  agents: [{ runner: "claude-code", model: "claude-sonnet-4-6" }],
  verdict: "judge",
  judge: { model: "claude-opus-4-8" },
});
