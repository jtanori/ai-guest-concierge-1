/**
 * Neon Functions wiring.
 *
 * Functions are long-running serverless endpoints close to the database.
 * The hello sample was deployed by `neon deploy`; its public HTTPS URL is
 * injected as NEON_FUNCTION_HELLO_BASE_URL. Auth hardening (JWT or API key
 * at the top of every real function) comes with S01+ — the probe only
 * proves the service round-trips.
 */
export class FunctionsEnvError extends Error {}

export async function invokeHello(
  source: Record<string, string | undefined> = process.env,
): Promise<{ status: number; body: string }> {
  const baseUrl = source["NEON_FUNCTION_HELLO_BASE_URL"];
  if (!baseUrl) throw new FunctionsEnvError("missing NEON_FUNCTION_HELLO_BASE_URL");
  const res = await fetch(baseUrl, { signal: AbortSignal.timeout(8000) });
  return { status: res.status, body: await res.text() };
}
