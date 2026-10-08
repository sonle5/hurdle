import { defineSuite } from "hurdle";

export default defineSuite({
  tasks: ["./tasks/copy-message"],
  agents: [{ runner: "claude-code", model: "claude-opus-5-5", effort: "medium" }],
  verdict: "code",
});
