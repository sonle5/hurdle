import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export type TogetherRequest = {
  ts?: string;
  method?: string;
  path?: string;
  status?: number;
  model?: string | null;
  response_id?: string | null;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  duration_ms?: number | null;
  // WebSocket connection summary (one row per connection, from websocket_end).
  frames_sent?: number | null;
  frames_recv?: number | null;
  bytes_sent?: number | null;
  bytes_recv?: number | null;
};

// HH:MM:SS straight from the ISO string (UTC) — deterministic, no timezone math,
// so it's SSR-safe. (The conversation view renders local time; these are UTC.)
function utcTime(ts?: string): string {
  return ts && ts.length >= 19 ? ts.slice(11, 19) : "—";
}

function fmtBytes(n?: number | null): string {
  if (!n) return "0B";
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

// The egress-proxy capture: every Together API call the agent actually made,
// logged out-of-band so a pass is backed by real server receipts, not narration.
export function TogetherRequestsCard({ requests }: { requests: TogetherRequest[] }) {
  if (!requests || requests.length === 0) return null;
  // 101 (WS upgrade) counts as ok, not a failure.
  const failed = requests.filter((r) => !r.status || (r.status !== 101 && (r.status < 200 || r.status >= 300))).length;

  return (
    <div className="rounded-lg border border-rule overflow-hidden bg-background">
      <div className="flex items-center justify-between px-5 py-3 border-b border-rule bg-surface/40">
        <h2 className="text-xs font-semibold text-fg-muted uppercase tracking-[0.08em]">
          Together API Calls — captured
        </h2>
        <span className="text-xs text-fg-muted tabular-nums">
          {requests.length} call{requests.length !== 1 ? "s" : ""}
          {failed > 0 && <span className="text-fail"> · {failed} non-2xx</span>}
        </span>
      </div>
      <div className="max-h-96 overflow-x-auto overflow-y-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-20">Time<span className="text-fg-faint font-normal"> ·UTC</span></TableHead>
              <TableHead className="w-16">Status</TableHead>
              <TableHead>Endpoint</TableHead>
              <TableHead>Model</TableHead>
              <TableHead className="text-right w-20">Tokens</TableHead>
              <TableHead className="text-right w-16">ms</TableHead>
              <TableHead className="w-44">Response ID</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {requests.map((r, i) => {
              const isWs = r.method === "WS" || r.frames_sent != null;
              const ok = !!r.status && ((r.status >= 200 && r.status < 300) || r.status === 101);
              const tokens = r.prompt_tokens != null || r.completion_tokens != null
                ? `${r.prompt_tokens ?? 0}→${r.completion_tokens ?? 0}`
                : "—";
              const time = utcTime(r.ts);
              return (
                <TableRow key={r.response_id || `${r.path}-${i}`}>
                  <TableCell className="font-mono text-[11px] text-fg-muted tabular-nums whitespace-nowrap">
                    {time}
                  </TableCell>
                  <TableCell>
                    <span className={`inline-flex items-center gap-1.5 text-xs tabular-nums ${ok ? "text-pass" : "text-fail"}`}>
                      <span className={`h-1.5 w-1.5 rounded-full ${ok ? "bg-pass" : "bg-fail"}`} />
                      {r.status ?? "?"}
                    </span>
                  </TableCell>
                  <TableCell className="font-mono text-[11px]">
                    <span className="text-fg-faint">{r.method} </span>{r.path}
                  </TableCell>
                  <TableCell className="font-mono text-[11px] text-fg-muted">
                    {isWs
                      ? <span title="frames · bytes (↑ client→server, ↓ server→client)">↑{r.frames_sent ?? 0}f {fmtBytes(r.bytes_sent)} · ↓{r.frames_recv ?? 0}f {fmtBytes(r.bytes_recv)}</span>
                      : (r.model || "—")}
                  </TableCell>
                  <TableCell className="text-right font-mono text-[11px] text-fg-muted tabular-nums">{isWs ? "—" : tokens}</TableCell>
                  <TableCell className="text-right font-mono text-[11px] text-fg-muted tabular-nums">{r.duration_ms ?? "—"}</TableCell>
                  <TableCell className="font-mono text-[10px] text-fg-faint truncate">{r.response_id || "—"}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
