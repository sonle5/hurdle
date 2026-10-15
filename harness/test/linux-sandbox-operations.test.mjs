import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import { snapshotSandboxProcesses } from "../lib/execution-environments/linux-sandbox-operations.mjs";

const PF_KTHREAD = 0x00200000;
const linuxProc = existsSync("/proc/2/stat") && existsSync("/usr/bin/python3");

function isKernelThread(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return (Number(fields[6]) & PF_KTHREAD) !== 0;
  } catch {
    return false;
  }
}

// The census script runs inside sandboxes; this host's /proc stands in for one.
test("the sandbox process census ignores kernel threads", { skip: !linuxProc && "requires Linux /proc and /usr/bin/python3" }, async (t) => {
  assert.ok(isKernelThread(2), "kthreadd must be a kernel thread for this test to be meaningful");
  const sleeper = spawn("sleep", ["30"], { stdio: "ignore" });
  t.after(() => sleeper.kill());
  const workload = {
    commands: {
      async run(script) {
        const result = spawnSync("bash", ["-c", script], { encoding: "utf8" });
        return { stdout: result.stdout, stderr: result.stderr, exitCode: result.status };
      },
    },
  };

  const pids = (await snapshotSandboxProcesses(workload)).map(([pid]) => pid);

  // Kernel workers come and go with disk writeback and cannot be signalled;
  // counting them made busy sandbox runs fail their quiescence check.
  assert.deepEqual(pids.filter(isKernelThread), []);
  assert.ok(pids.includes(sleeper.pid), "user processes must still be counted");
});
