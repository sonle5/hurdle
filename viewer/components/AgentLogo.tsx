import { cn } from "@/lib/utils";

export type AgentCode = "CC" | "Pi" | "CDX" | "OC";

const MONOCHROME_AGENTS = new Set<AgentCode>(["CDX", "Pi"]);

function agentLogoSource(agent: AgentCode) {
  if (agent === "CC") return "/claude-logo.svg";
  if (agent === "CDX") return "/codex-logo.svg";
  if (agent === "OC") return "/opencode-logo.svg";
  return "/pi-logo.svg";
}

export function AgentLogo({
  agent,
  className,
}: {
  agent: AgentCode;
  className?: string;
}) {
  return (
    <img
      src={agentLogoSource(agent)}
      alt=""
      className={cn(
        "shrink-0",
        MONOCHROME_AGENTS.has(agent) && "dark:brightness-0 dark:invert",
        className,
      )}
    />
  );
}
