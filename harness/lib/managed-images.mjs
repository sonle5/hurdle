// Hurdle builds its own sandbox images and names them after the Agent CLIs
// inside, for example hurdle-claude-code-codex:v2 (E2B) or
// hurdle-codex-network@v2 (Together). The tag is the highest image version
// among those Agents.
export const SETUP_AGENT_PACKAGES = Object.freeze({
  "claude-code": "@anthropic-ai/claude-code@2.1.288",
  codex: "@openai/codex@0.159.3",
});

// When a pin above changes, set that Agent's version to one more than the
// highest version here. Only images containing that Agent get a new name, so
// setup rebuilds them and readiness flags the ones built before.
const IMAGE_VERSIONS = Object.freeze({ "claude-code": 1, codex: 2 });

const AGENT_IDS = Object.keys(SETUP_AGENT_PACKAGES);
const AGENTS = `((?:${AGENT_IDS.join("|")})(?:-(?:${AGENT_IDS.join("|")}))*)`;
const MANAGED_IMAGE_NAMES = Object.freeze({
  e2b: new RegExp(`^hurdle-${AGENTS}()?:v\\d+$`),
  together: new RegExp(`^hurdle-${AGENTS}(-network)?@v\\d+$`),
});

export function managedImageName(agents, provider, { network = false } = {}) {
  const ids = [...new Set(agents)].sort();
  const name = `hurdle-${ids.join("-")}`;
  const version = `v${Math.max(...ids.map((id) => IMAGE_VERSIONS[id]))}`;
  return provider === "together"
    ? `${name}${network ? "-network" : ""}@${version}`
    : `${name}:${version}`;
}

// Describe a Hurdle-built image name, or return null for a caller-owned image
// that setup must not replace. A current image is the one setup would build
// now for the same Agents.
export function managedImageAgents(name, provider) {
  const match = MANAGED_IMAGE_NAMES[provider].exec(name ?? "");
  if (!match) return null;
  const agents = AGENT_IDS.filter((id) => `-${match[1]}-`.includes(`-${id}-`));
  const network = Boolean(match[2]);
  return { agents, network, current: name === managedImageName(agents, provider, { network }) };
}
