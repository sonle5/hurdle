import { createExternalGuardianController } from "./e2b-guardian.mjs";
import { startTogetherControllerRelay } from "./together-controller-relay.mjs";

export const TOGETHER_GUARDIAN_PORT = 18081;
export const TOGETHER_WORKLOAD_BRIDGE_PORT = 18083;

export function createTogetherGuardianController({ startRelay = startTogetherControllerRelay } = {}) {
  const shared = createExternalGuardianController({
    producer: "together-guardian", requiresTrafficAccessToken: false,
    firewallSuffix: "-legacy", firewallVerdict: "DROP", workloadBridgeMode: "reverse-client",
    bridgeEnvironment: () => ({ EGRESS_BRIDGE_PUBLIC_LISTEN_PORT: String(TOGETHER_WORKLOAD_BRIDGE_PORT) }),
  });
  return Object.freeze({ ...shared, async attach(input) {
    await shared.attach(input);
    input.session.controllerRelay = await startRelay({
      workloadUrl: `wss://${input.workload.getHost(TOGETHER_WORKLOAD_BRIDGE_PORT)}`,
      guardianUrl: `wss://${input.session.guardianHost}/proxy`,
      cellToken: input.session.bridgeToken, signal: input.signal,
    });
    // Prove the complete loopback -> controller -> Guardian TCP path before
    // starting an Agent. CONNECT opens TLS transport without an API request.
    const checked = await input.workload.commands.run(String.raw`node - <<'JS'
const socket = require('node:net').createConnection({ host: '127.0.0.1', port: 18082 });
let received = '';
const timer = setTimeout(() => { socket.destroy(); process.exitCode = 1; }, 10000);
socket.once('connect', () => socket.write('CONNECT ' + process.env.HURDLE_CAPTURE_HOST + ':443 HTTP/1.1\r\nHost: ' + process.env.HURDLE_CAPTURE_HOST + ':443\r\n\r\n'));
socket.on('data', data => {
  received += data.toString();
  if (received.length > 16384) { socket.destroy(); process.exitCode = 1; }
  else if (received.includes('\r\n\r\n')) {
    if (/^HTTP\/1\.[01] 200 /.test(received)) console.log('GUARDIAN_BRIDGE_READY');
    else process.exitCode = 1;
    socket.destroy();
  }
});
socket.once('error', () => { process.exitCode = 1; });
socket.once('close', () => { clearTimeout(timer); if (!/^HTTP\/1\.[01] 200 /.test(received)) process.exitCode = 1; });
JS`, { user: "root", timeoutMs: 15000, signal: input.signal,
      envs: { HURDLE_CAPTURE_HOST: input.session.hosts[0] } });
    if (!checked.stdout?.includes('GUARDIAN_BRIDGE_READY')) throw new Error('Together Guardian end-to-end preflight failed');
    input.session.controllerRelay.assertHealthy();
    // The SDK root-exec endpoint must never be accessible to the Agent.
    await input.workload.commands.run(`set -eu
for binary in /usr/sbin/iptables-legacy /usr/sbin/ip6tables-legacy; do
  "$binary" --wait 5 -I OUTPUT 1 -p tcp --dport 57468 -j DROP
  "$binary" --wait 5 -C OUTPUT -p tcp --dport 57468 -j DROP
done`, { user: "root", timeoutMs: 10000, signal: input.signal });
  }, async seal(input) {
    input.session.controllerRelay.assertHealthy();
    input.session.controllerRelay.allowShutdown();
    try { return await shared.seal(input); }
    finally { input.session.controllerRelay.close(); }
  }, close(session) { session?.controllerRelay?.close(); } });
}

// The current SDK exposes the authenticated agent URL rather than url_format.
// This port substitution has been verified against an actual application port.
// Refuse unfamiliar routing layouts instead of inventing a public endpoint.
export function togetherApplicationHost(agentUrl, port) {
  const url = new URL(agentUrl);
  if (url.protocol !== "https:" || url.username || url.password
    || !Number.isSafeInteger(port) || port < 1 || port > 65535
    || !/-57468\./.test(url.hostname)) {
    throw new Error("Together application-port routing is unavailable");
  }
  url.hostname = url.hostname.replace("-57468.", `-${port}.`);
  return url.host;
}

// Together does not yet offer provider-managed outbound rules. Install the
// equivalent deny-by-default rules in the controller-only Guardian VM. The
// workload separately rejects all resolved capture-host IPv4/IPv6 addresses.
export async function restrictTogetherGuardianNetwork(resource, policy, { signal } = {}) {
  if (!Array.isArray(policy?.allowOut) || policy.allowOut.length > 128
    || policy.denyOut?.length !== 1 || policy.denyOut[0] !== "0.0.0.0/0") {
    throw new TypeError("unsupported Together Guardian network policy");
  }
  await resource.commands.run(`python3 - <<'PY'
import ipaddress, json, os, socket, subprocess
hosts = json.loads(os.environ["HURDLE_GUARDIAN_HOSTS"])
addresses = set()
for host in hosts:
    found = set()
    for family, _, _, _, address in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM):
        if family not in (socket.AF_INET, socket.AF_INET6):
            continue
        parsed = ipaddress.ip_address(address[0])
        if not parsed.is_global:
            raise SystemExit("Guardian capture host resolved outside public address space")
        found.add(parsed)
    if not found:
        raise SystemExit("Guardian capture host resolved no public addresses")
    addresses.update(found)
if len(addresses) > 128:
    raise SystemExit("Guardian resolution exceeded its address bound")
resolvers = set()
with open('/etc/resolv.conf') as handle:
    for line in handle:
        parts = line.split()
        if len(parts) >= 2 and parts[0] == 'nameserver':
            resolvers.add(ipaddress.ip_address(parts[1]))
chain = 'HURDLE_GUARDIAN_OUT'
for version, binary in [(4, '/usr/sbin/iptables-legacy'), (6, '/usr/sbin/ip6tables-legacy')]:
    def command(*args):
        subprocess.run([binary, '--wait', '5', *args], check=True, stdout=subprocess.DEVNULL)
    command('-N', chain)
    command('-A', chain, '-o', 'lo', '-j', 'ACCEPT')
    # This kernel lacks conntrack. Replies from the two controller-owned
    # listeners must still reach their clients; initial outbound connections
    # remain restricted to capture destinations and DNS below.
    for port in ('57468', '18081'):
        command('-A', chain, '-p', 'tcp', '--sport', port, '-j', 'ACCEPT')
    for address in sorted(resolvers, key=str):
        if address.version != version:
            continue
        for protocol in ('udp', 'tcp'):
            command('-A', chain, '-d', str(address), '-p', protocol, '--dport', '53', '-j', 'ACCEPT')
    for address in sorted(addresses, key=str):
        if address.version == version:
            command('-A', chain, '-d', str(address), '-p', 'tcp', '-j', 'ACCEPT')
    command('-A', chain, '-j', 'DROP')
    command('-I', 'OUTPUT', '1', '-j', chain)
    command('-C', 'OUTPUT', '-j', chain)
print('GUARDIAN_NETWORK_RESTRICTED')
PY`, { user: "root", timeoutMs: 30_000, signal,
    envs: { HURDLE_GUARDIAN_HOSTS: JSON.stringify(policy.allowOut) } });
}
