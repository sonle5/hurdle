#!/usr/bin/env node

import { connectEngineShim, ENGINE_PORT } from "../lib/execution-environments/engine-shim.mjs";

// `nexus-compiler` inside a Hurdle sandbox; the image links it onto PATH. The
// command runs on the controller host, never here: this forwards argv and
// stdin over the sandbox socket and gives back the call's stdout, stderr and
// exit code. Only this name is served; `python3 -m nexus_compiler` does not
// exist in the sandbox.
process.exitCode = await connectEngineShim({
  argv: process.argv.slice(2),
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  port: ENGINE_PORT,
});
