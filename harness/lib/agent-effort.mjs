export const AGENT_EFFORTS = Object.freeze(["low", "medium", "high", "xhigh", "max"]);

export function isAgentEffort(value) {
  return AGENT_EFFORTS.includes(value);
}
