export const CLAUDE_CODE_VERSION = "2.1.221";
export const CLAUDE_CODE_NODE_MAJOR = 22;
export const CLAUDE_CODE_NODE_VERSION = "22.23.1";

export function claudeCodePackageSpec() {
  return `@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}`;
}

export function claudeCodeNodeInstallShell({ attempts = 3 } = {}) {
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 5) {
    throw new Error("Node install attempts must be an integer from 1 to 5");
  }
  return [
    "set -euo pipefail",
    `expected_node_major=${CLAUDE_CODE_NODE_MAJOR}`,
    `pinned_node_version=${CLAUDE_CODE_NODE_VERSION}`,
    "node_major=\"$(node -p 'process.versions.node.split(\".\")[0]')\"",
    "if [ \"$node_major\" -lt \"$expected_node_major\" ]; then",
    `  for attempt in $(seq 1 ${attempts}); do`,
    "    if npm install -g --no-audit --no-fund --fetch-retries=5 n@10.2.0; then",
    "      break",
    "    fi",
    `    if [ "$attempt" -eq ${attempts} ]; then`,
    "      echo \"Node installer bootstrap failed after $attempt attempt(s)\" >&2",
    "      exit 1",
    "    fi",
    "    sleep \"$((attempt * 2))\"",
    "  done",
    "  n \"$pinned_node_version\"",
    "  hash -r",
    "fi",
    "node_major=\"$(node -p 'process.versions.node.split(\".\")[0]')\"",
    "if [ \"$node_major\" -lt \"$expected_node_major\" ]; then",
    "  echo \"Claude Code requires Node >=${expected_node_major}; found $(node --version)\" >&2",
    "  exit 2",
    "fi",
    "node --version",
  ].join("\n");
}

export function claudeCodeInstallShell({ attempts = 3 } = {}) {
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 5) {
    throw new Error("Claude Code install attempts must be an integer from 1 to 5");
  }
  return [
    "set -euo pipefail",
    `expected_node_major=${CLAUDE_CODE_NODE_MAJOR}`,
    `expected_claude_version=${CLAUDE_CODE_VERSION}`,
    "node_major=\"$(node -p 'process.versions.node.split(\".\")[0]')\"",
    "if [ \"$node_major\" -lt \"$expected_node_major\" ]; then",
    "  echo \"Claude Code requires Node >=${expected_node_major}; found $(node --version)\" >&2",
    "  exit 2",
    "fi",
    "if command -v claude >/dev/null 2>&1 && claude --version | grep -Fq \"$expected_claude_version\"; then",
    "  echo \"Claude Code $expected_claude_version is already installed\"",
    "else",
    `  for attempt in $(seq 1 ${attempts}); do`,
    `    if npm install -g --no-audit --no-fund --fetch-retries=5 --fetch-retry-mintimeout=1000 --fetch-retry-maxtimeout=10000 ${claudeCodePackageSpec()}; then`,
    "      break",
    "    fi",
    `    if [ "$attempt" -eq ${attempts} ]; then`,
    "      echo \"Claude Code install failed after $attempt attempt(s)\" >&2",
    "      exit 1",
    "    fi",
    "    sleep \"$((attempt * 2))\"",
    "  done",
    "fi",
    "claude_version=\"$(claude --version)\"",
    "printf '%s\\n' \"$claude_version\"",
    "printf '%s' \"$claude_version\" | grep -Fq \"$expected_claude_version\" || {",
    "  echo \"Expected Claude Code $expected_claude_version\" >&2",
    "  exit 1",
    "}",
  ].join("\n");
}

export function claudeCodeRuntimeInstallShell(options = {}) {
  return [
    claudeCodeNodeInstallShell(options),
    claudeCodeInstallShell(options),
  ].join("\n");
}
