import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("../proxy.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext },
});
const resolved = outputText.replace('"next/server"', JSON.stringify(pathToFileURL(require.resolve("next/server")).href));
const { proxy } = await import("data:text/javascript," + encodeURIComponent(resolved));

function request(host, method = "GET") {
  return {
    // Next can normalize nextUrl to the bound server's hostname. It is not
    // proof that the client's Host header used a loopback authority.
    nextUrl: new URL("http://127.0.0.1:30147/"),
    headers: new Headers(host === null ? {} : { host }),
    method,
  };
}

test("Viewer admission checks the raw Host, not Next's normalized server URL", () => {
  for (const host of [null, "attacker.invalid", "localhost.attacker.invalid", "127.0.0.1.attacker.invalid",
    "localhost@attacker.invalid", "attacker.invalid, localhost", "localhost/path", "localhost:99999"]) {
    assert.equal(proxy(request(host)).status, 403, String(host));
  }
  for (const host of ["localhost", "localhost:3000", "LOCALHOST:3000", "127.0.0.1:30147", "[::1]:3000"]) {
    assert.equal(proxy(request(host)).headers.get("x-middleware-next"), "1", host);
  }
});

test("Viewer admission never permits a write method, even on loopback", () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    const response = proxy(request("localhost:3000", method));
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.get("allow"), "GET, HEAD");
  }
  assert.equal(proxy(request("localhost", "HEAD")).headers.get("x-middleware-next"), "1");
});
