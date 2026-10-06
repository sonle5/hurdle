import { defineSuite } from "tae";

export default defineSuite({
  tasks: ["./tasks/copy-message"],
  agents: [{ runner: "claude-code" }],
  verdict: "code",
});
