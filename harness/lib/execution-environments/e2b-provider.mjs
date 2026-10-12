import { createLinuxSandboxOperations } from "./linux-sandbox-operations.mjs";

export function createE2BProvider({ loadSdk = () => import("e2b") } = {}) {
  return Object.freeze({
    async acquire({
      role,
      template,
      maxLifetimeMs,
      apiKey,
    }) {
      const { Sandbox } = await loadSdk();
      // Allocation is deliberately not abortable: if cancellation races a
      // successful remote allocation, the caller must receive the handle and
      // put it through the confirmed disposal barrier.
      return Sandbox.create(template, {
        apiKey,
        timeoutMs: maxLifetimeMs,
        secure: true,
        ...(role === "capture"
          ? { network: { allowPublicTraffic: false } }
          : {}),
        metadata: { "hurdle-role": role },
      });
    },
    async validate(resource, { cpuCount, memoryMiB, signal }) {
      const info = await resource.getInfo({ signal });
      if (info.cpuCount !== cpuCount || info.memoryMB !== memoryMiB) {
        throw new Error("E2B template capacity does not match the requested settings");
      }
    },
    ...createLinuxSandboxOperations(),
    async dispose(resource) {
      let lastError = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await resource.kill({ requestTimeoutMs: 30_000 });
          return;
        } catch (error) {
          if (error?.name === "SandboxNotFoundError") return;
          lastError = error;
          if (attempt < 2) {
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
        }
      }
      throw lastError ?? new Error("E2B resource disposal failed");
    },
    async isDisposed(resource) {
      try {
        return !(await resource.isRunning({ requestTimeoutMs: 10_000 }));
      } catch (error) {
        if (error?.name === "SandboxNotFoundError") return true;
        throw error;
      }
    },
  });
}
