/** Only the tailnet gateway's Access identity may reach browser session sockets. */
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { isBrowserWebSocketRequest } from "./websocket-ingress";

export interface BrowserIngressBindings {
  CONTROL_PLANE_BROWSER: Pick<Fetcher, "fetch">;
  ACCESS_ISSUER: string;
  ACCESS_AUDIENCE: string;
  ACCESS_SERVICE_TOKEN_CLIENT_ID: string;
}

let keyCache: { issuer: string; keys: JWTVerifyGetKey } | undefined;
function accessKeys(issuer: string): JWTVerifyGetKey {
  if (keyCache?.issuer !== issuer) {
    keyCache = {
      issuer,
      keys: createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), {
        timeoutDuration: 5000,
      }),
    };
  }
  return keyCache.keys;
}

export async function handleBrowserIngress(
  request: Request,
  env: BrowserIngressBindings,
  keys?: JWTVerifyGetKey
): Promise<Response> {
  if (!isBrowserWebSocketRequest(request)) return new Response("Not found", { status: 404 });
  // Never derive the key endpoint or expected claims from request headers/the JWT.
  if (
    !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(env.ACCESS_ISSUER ?? "") ||
    !env.ACCESS_AUDIENCE ||
    !env.ACCESS_SERVICE_TOKEN_CLIENT_ID
  ) {
    return new Response("Ingress unavailable", { status: 503 });
  }
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token || token.length > 16384) return new Response("Forbidden", { status: 403 });
  try {
    const { payload } = await jwtVerify(token, keys ?? accessKeys(env.ACCESS_ISSUER), {
      issuer: env.ACCESS_ISSUER,
      audience: env.ACCESS_AUDIENCE,
      algorithms: ["RS256"],
      requiredClaims: ["exp", "iat", "common_name"],
    });
    if (payload.common_name !== env.ACCESS_SERVICE_TOKEN_CLIENT_ID) {
      return new Response("Forbidden", { status: 403 });
    }
  } catch {
    // Do not log assertions, credentials, or query strings.
    return new Response("Forbidden", { status: 403 });
  }
  const headers = new Headers(request.headers);
  for (const name of [
    "Cf-Access-Jwt-Assertion",
    "CF-Access-Client-Id",
    "CF-Access-Client-Secret",
  ]) {
    headers.delete(name);
  }
  // This binding targets the private named entrypoint, not the public fetch handler.
  // The user's session-specific subscription token is still required by the session.
  return env.CONTROL_PLANE_BROWSER.fetch(new Request(request, { headers }));
}

export default {
  fetch: (request: Request, env: BrowserIngressBindings) => handleBrowserIngress(request, env),
};
