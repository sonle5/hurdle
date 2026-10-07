import { defineSuite } from "hurdle";

export default defineSuite({
  tasks: ["./tasks/copy-message"],
  agents: [{ runner: "claude-code" }],
  verdict: "code",
});
