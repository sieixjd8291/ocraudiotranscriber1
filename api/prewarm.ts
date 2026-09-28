// Warms the serverless instance that serves api/process-file. Deliberately does
// NOT call Gemini: warm-up generateContent calls burned free-tier quota (429s)
// without making real transcriptions any faster.
export function POST(): Response {
  return new Response(JSON.stringify({ status: "success", warmed: "function" }), {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
