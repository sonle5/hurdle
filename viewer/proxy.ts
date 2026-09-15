import { NextResponse, type NextRequest } from "next/server";

// A local read-only tool, not a remotely hosted authenticated app.
// Loopback binding is also set in the source dev/start scripts and launcher.
export function proxy(request: NextRequest) {
  // nextUrl may contain the normalized bind address rather than the client Host.
  // Check the raw authority to reject DNS-rebinding hosts and malformed ports.
  const authority = request.headers.get("host") ?? "";
  const host = /^(localhost|127\.0\.0\.1|\[::1\])(?::([1-9]\d{0,4}))?$/i.exec(authority);
  if (!host || (host[2] && Number(host[2]) > 65535)) {
    return new NextResponse("The Results Viewer is local-only.", { status: 403 });
  }
  if (!["GET", "HEAD"].includes(request.method)) {
    return new NextResponse("The Results Viewer is read-only.", { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  return NextResponse.next();
}

export const config = { matcher: "/:path*" };
