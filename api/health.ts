// Lets the client detect that the server-side Gemini route (api/process-file)
// is deployed. Response shape matches server.ts's /api/health.
export function GET(): Response {
  return new Response(JSON.stringify({ status: "ok", gemini: "server" }), {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
