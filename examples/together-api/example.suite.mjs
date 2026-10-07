import { defineSuite } from "hurdle";

export default defineSuite({
  api: {
    authorizationCredential: "TOGETHER_API_KEY",
    hosts: ["api.together.ai", "api.together.xyz"],
  },
  tasks: ["./tasks/together-api"],
  agents: [{ runner: "claude-code" }],
  verdict: "code",
});
