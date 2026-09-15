"use strict";

// Node 20 doesn't honor HTTP_PROXY / HTTPS_PROXY for native fetch, and core
// https clients (including `ws`) don't use those variables automatically.
// Preload this file with NODE_OPTIONS so agent-authored Node clients cannot
// bypass the eval proxy and send the sandbox-only credential upstream.

const https = require("node:https");
const { getGlobalDispatcher, ProxyAgent, setGlobalDispatcher } = require("undici");
const { HttpsProxyAgent } = require("https-proxy-agent");

const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
const captureHosts = (() => {
  try {
    const values = JSON.parse(process.env.TAE_EGRESS_CAPTURE_HOSTS || "[]");
    if (!Array.isArray(values)) return new Set();
    return new Set(values.map((value) => String(value).toLowerCase()));
  } catch {
    return new Set();
  }
})();

function isCaptureHost(value) {
  const host = String(value || "").toLowerCase().replace(/\.$/, "");
  return captureHosts.has(host);
}

function hostnameFromOrigin(origin) {
  try {
    return new URL(String(origin)).hostname;
  } catch {
    return "";
  }
}

if (process.env.TOGETHER_EGRESS_SMOKE === "1" && typeof globalThis.fetch === "function") {
  const directFetch = globalThis.fetch;
  if (!directFetch._togetherEgressSmokeMarker) {
    const markedTogetherFetch = function markedTogetherFetch(input, init) {
      const rawUrl = typeof input === "string" || input instanceof URL
        ? input
        : input?.url;
      if (!isCaptureHost(hostnameFromOrigin(rawUrl))) {
        return directFetch(input, init);
      }
      const request = new Request(input, init);
      const headers = new Headers(request.headers);
      headers.set("X-Together-Eval-Egress-Smoke-Client", "node-fetch");
      return directFetch(new Request(request, { headers }));
    };
    markedTogetherFetch._togetherEgressSmokeMarker = true;
    globalThis.fetch = markedTogetherFetch;
  }
}

if (proxyUrl) {
  // Native fetch and libraries backed by undici share the global dispatcher.
  const directDispatcher = getGlobalDispatcher();
  const proxyDispatcher = new ProxyAgent(proxyUrl);
  setGlobalDispatcher({
    dispatch(options, handler) {
      const dispatcher = isCaptureHost(hostnameFromOrigin(options?.origin))
        ? proxyDispatcher
        : directDispatcher;
      return dispatcher.dispatch(options, handler);
    },
    close(...args) {
      return proxyDispatcher.close(...args);
    },
    destroy(...args) {
      return proxyDispatcher.destroy(...args);
    },
  });

  // Core https is used by WebSocket clients such as `ws`. Delegate only
  // Together destinations to the proxy and leave every other host untouched.
  const directHttpsAgent = https.globalAgent;
  const proxyHttpsAgent = new HttpsProxyAgent(proxyUrl);
  const directHttpsRequest = https.request;

  function requestHostname(args) {
    const first = args[0];
    const second = args[1];
    const optionHost = second && typeof second === "object"
      ? second.hostname || second.host
      : null;
    if (optionHost) return String(optionHost).split(":")[0];
    if (typeof first === "string" || first instanceof URL) {
      return hostnameFromOrigin(first);
    }
    return String(first?.hostname || first?.host || "").split(":")[0];
  }

  function proxyTogetherHttpsRequest(...args) {
    if (!isCaptureHost(requestHostname(args))) {
      return Reflect.apply(directHttpsRequest, https, args);
    }

    const first = args[0];
    if (typeof first === "string" || first instanceof URL) {
      if (args[1] && typeof args[1] === "object") {
        args[1] = { ...args[1], agent: proxyHttpsAgent };
      } else {
        args.splice(1, 0, { agent: proxyHttpsAgent });
      }
    } else {
      args[0] = { ...first, agent: proxyHttpsAgent };
    }
    return Reflect.apply(directHttpsRequest, https, args);
  }

  // `https.request()` uses Node's internal default-agent binding, so replacing
  // the exported `https.globalAgent` alone does not affect clients such as
  // `ws`. Wrap the public request APIs and force Together destinations through
  // the selective proxy even when a client supplies its own agent.
  https.request = proxyTogetherHttpsRequest;
  https.get = (...args) => {
    const request = proxyTogetherHttpsRequest(...args);
    request.end();
    return request;
  };

  class TogetherRoutingAgent extends https.Agent {
    addRequest(request, options) {
      const dispatcher = isCaptureHost(options?.hostname || options?.host)
        ? proxyHttpsAgent
        : directHttpsAgent;
      return dispatcher.addRequest(request, options);
    }

    destroy() {
      proxyHttpsAgent.destroy();
      super.destroy();
    }
  }
  https.globalAgent = new TogetherRoutingAgent();
}
