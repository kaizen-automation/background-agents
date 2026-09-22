import {
  evaluateTailnetGate,
  tailnetGateDeniedResponse,
  withoutTailnetProxyHeader,
} from "@open-inspect/shared/tailnet-proxy";

/**
 * Worker-level ingress gate for a tailnet-only deployment: every request to
 * the web Worker (pages, assets, API routes, OAuth callbacks) must arrive
 * through the tailnet proxy. Returns the request to hand to Next.js, or the
 * response that refuses it.
 */
export function admitWebRequestThroughTailnetGate(
  request: Request,
  configuredToken: string | undefined
): { admitted: true; request: Request } | { admitted: false; response: Response } {
  if (evaluateTailnetGate(request.headers, configuredToken) === "denied") {
    return { admitted: false, response: tailnetGateDeniedResponse() };
  }
  return { admitted: true, request: withoutTailnetProxyHeader(request) };
}
