import { getCanonicalResultsSource } from "@/lib/canonical-results.server";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const path = new URL(request.url).searchParams.get("path");
  if (!/^run_[a-f0-9-]{36}$/.test(id) || !path) {
    return Response.json({ error: "Evaluator source is not available." }, { status: 404 });
  }

  const results = await getCanonicalResultsSource();
  if (results.status !== "ready") {
    return Response.json({ error: "Evaluator source is not available." }, { status: 404 });
  }

  try {
    return Response.json(await results.client.readEvaluatorSource(id, path), {
      headers: { "Cache-Control": "private, max-age=31536000, immutable" },
    });
  } catch {
    return Response.json({ error: "Evaluator source is not available." }, { status: 404 });
  }
}
