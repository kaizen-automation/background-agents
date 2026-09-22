import { evaluateTailnetGate } from "@open-inspect/shared/tailnet-proxy";

/**
 * Browsers are the only WebSocket clients that reach this Worker directly, so
 * a tailnet-only deployment admits a client upgrade only through the proxy.
 * Sandbox upgrades come from the data plane with their own token and are
 * authenticated by the Durable Object. HTTP routes are not gated here: every
 * non-health route already requires a signed service, sandbox, or user
 * credential, and the web Worker (itself behind the gate) is the browser's
 * only path to them.
 */
export function admitWebSocketThroughTailnetGate(
  request: Request,
  url: URL,
  configuredToken: string | undefined
): boolean {
  const decision = evaluateTailnetGate(request.headers, configuredToken);
  if (decision !== "denied") return true;
  return url.searchParams.get("type") === "sandbox";
}
