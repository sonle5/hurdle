import { defineSuite } from "tae";

export default defineSuite({
  api: {
    authorizationCredential: "TOGETHER_API_KEY",
    hosts: ["api.together.ai", "api.together.xyz"],
  },
  tasks: [
    "./tasks/gpu-clusters",
    "./tasks/rag-search",
    "./tasks/tool-calling-agent-loop",
    "./tasks/chat-app",
  ],
  agents: [{ runner: "claude-code", model: "claude-sonnet-4-6" }],
  conditions: {
    baseline: { skills: [], mcpServers: [] },
    mcp: {
      skills: [],
      mcpServers: [{
        id: "together-docs",
        transport: { kind: "http", url: "https://docs.together.ai/mcp" },
      }],
    },
    skills: {
      skills: [
        { name: "together-audio", sourceDirectory: "skills/together-audio" },
        { name: "together-batch-inference", sourceDirectory: "skills/together-batch-inference" },
        { name: "together-chat-completions", sourceDirectory: "skills/together-chat-completions" },
        { name: "together-dedicated-containers", sourceDirectory: "skills/together-dedicated-containers" },
        { name: "together-dedicated-endpoints", sourceDirectory: "skills/together-dedicated-endpoints" },
        { name: "together-embeddings", sourceDirectory: "skills/together-embeddings" },
        { name: "together-evaluations", sourceDirectory: "skills/together-evaluations" },
        { name: "together-fine-tuning", sourceDirectory: "skills/together-fine-tuning" },
        { name: "together-gpu-clusters", sourceDirectory: "skills/together-gpu-clusters" },
        { name: "together-images", sourceDirectory: "skills/together-images" },
        { name: "together-sandboxes", sourceDirectory: "skills/together-sandboxes" },
        { name: "together-video", sourceDirectory: "skills/together-video" },
      ],
      mcpServers: [],
    },
  },
  repeats: 1,
  verdict: "judge",
  judge: { model: "claude-opus-4-8" },
});
