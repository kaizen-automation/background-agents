/**
 * Tailnet-only ingress: a deployment whose Workers must be reachable only
 * through a reverse proxy on the operator's Tailscale network.
 *
 * The proxy is the sole holder of a shared token and stamps it on every
 * upstream request; a Worker configured with the same token refuses any
 * request that does not carry it, so its public hostnames are dead ends.
 * An unset token disables the gate, which keeps open deployments unchanged.
 */

import { timingSafeEqual } from "./auth";

export const TAILNET_PROXY_HEADER = "X-OpenInspect-Tailnet-Proxy";

export const TAILNET_PROXY_TOKEN_MIN_LENGTH = 32;

export type TailnetGateDecision = "open" | "allowed" | "denied";

/** Normalize the configured token: unset or blank means the gate is open. */
export function normalizeTailnetProxyToken(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

/**
 * Whether the request may proceed under the configured token. "open" means no
 * token is configured (the gate is not enforced); "allowed" means the request
 * carries the token; "denied" means it does not.
 */
export function evaluateTailnetGate(
  headers: Headers,
  configuredToken: string | undefined
): TailnetGateDecision {
  const token = normalizeTailnetProxyToken(configuredToken);
  if (token === null) return "open";
  const presented = headers.get(TAILNET_PROXY_HEADER);
  if (presented === null) return "denied";
  return timingSafeEqual(presented, token) ? "allowed" : "denied";
}

/** Uniform refusal: no hint about which credential the request lacked. */
export function tailnetGateDeniedResponse(): Response {
  return new Response("Forbidden", {
    status: 403,
    headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
  });
}

/** Strip the proxy token before a request is forwarded anywhere it could leak. */
export function withoutTailnetProxyHeader(request: Request): Request {
  if (!request.headers.has(TAILNET_PROXY_HEADER)) return request;
  const headers = new Headers(request.headers);
  headers.delete(TAILNET_PROXY_HEADER);
  return new Request(request, { headers });
}
