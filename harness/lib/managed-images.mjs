// Agent CLIs baked into Hurdle's sandbox image, each pinned by exact version
// and by its registry tarball integrity, which the image build checks.
export const SETUP_AGENT_PACKAGES = Object.freeze({
  "claude-code": "@anthropic-ai/claude-code@2.1.288",
  codex: "@openai/codex@0.159.3",
  dsh: "@deepseek-ai/dsh@0.2.2-rc.3",
});

export const SETUP_AGENT_INTEGRITY = Object.freeze({
  "claude-code": "sha512-tnc8XuK5xQkyE6oowhhSPIjLuNc0S3MkjIHqycDsKP6yJlLtIjMt6v1TOkYLUiumcZ9jOgJZ6h9Vn3/f0murdQ==",
  codex: "sha512-hg4nlqCwRb87GocxNnHvz4sadOrdJ71mO0a4CUYWXjAozJe2gtuAdRFldKGSQXw9m7SgR4ydis12KDVVPgzDkQ==",
  dsh: "sha512-S+4oUYVKWuc1SCMMp1mpUa2llxVy0o9gIgp7TDg/Ea7PuvXVkAfnykqSH1/oDXVB+y5VzEm0QIJulo1LIB3qRg==",
});
