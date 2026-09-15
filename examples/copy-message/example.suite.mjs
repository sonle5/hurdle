import { defineSuite } from "tae";

export default defineSuite({
  tasks: ["./tasks/copy-message"],
  agents: [{ runner: "claude-code" }],
  conditions: { baseline: { skills: [], mcpServers: [] } },
  repeats: 1,
  verdict: "code",
});
