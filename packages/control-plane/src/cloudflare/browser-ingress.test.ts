import { beforeAll, describe, expect, it, vi } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from "jose";
import { handleBrowserIngress, type BrowserIngressBindings } from "./browser-ingress";
import { isBrowserWebSocketRequest, isSandboxWebSocketRequest } from "./websocket-ingress";

const issuer = "https://test.cloudflareaccess.com";
let privateKey: CryptoKey;
let keys: JWTVerifyGetKey;
beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  keys = createLocalJWKSet({
    keys: [{ ...(await exportJWK(pair.publicKey)), kid: "test", alg: "RS256" }],
  });
});
function request(path = "/sessions/test/ws", token?: string, method = "GET") {
  const headers: Record<string, string> = { Upgrade: "websocket" };
  if (token) headers["Cf-Access-Jwt-Assertion"] = token;
  return new Request(`https://ingress.example${path}`, { method, headers });
}
function bindings() {
  const fetch = vi.fn().mockResolvedValue(new Response("forwarded"));
  return {
    env: {
      ACCESS_ISSUER: issuer,
      ACCESS_AUDIENCE: "browser-audience",
      ACCESS_SERVICE_TOKEN_CLIENT_ID: "gateway.access",
      CONTROL_PLANE_BROWSER: { fetch },
    } as BrowserIngressBindings,
    fetch,
  };
}
async function token(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: issuer,
    aud: "browser-audience",
    common_name: "gateway.access",
    iat: now,
    exp: now + 60,
    ...overrides,
  })
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .sign(privateKey);
}

describe("browser ingress", () => {
  it("verifies the gateway JWT, strips credentials, and forwards only the socket request", async () => {
    const { env, fetch } = bindings();
    const req = request(undefined, await token());
    req.headers.set("CF-Access-Client-Secret", "synthetic-secret");
    req.headers.set("CF-Access-Client-Id", "gateway.access");
    expect((await handleBrowserIngress(req, env, keys)).status).toBe(200);
    const forwarded = fetch.mock.calls[0][0] as Request;
    expect(forwarded.url).toBe(req.url);
    expect(forwarded.headers.get("Upgrade")).toBe("websocket");
    for (const name of [
      "Cf-Access-Jwt-Assertion",
      "CF-Access-Client-Secret",
      "CF-Access-Client-Id",
    ]) {
      expect(forwarded.headers.has(name)).toBe(false);
    }
  });
  it.each([
    { aud: "another-application" },
    { iss: "https://other.cloudflareaccess.com" },
    { common_name: "another-token.access" },
    { exp: 1 },
    { exp: undefined },
    { iat: undefined },
    { common_name: undefined },
    { nbf: 9999999999 },
  ])("rejects signed assertions with invalid claims: %j", async (claims) => {
    const { env, fetch } = bindings();
    expect(
      (await handleBrowserIngress(request(undefined, await token(claims)), env, keys)).status
    ).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([undefined, "forged.jwt.value", "a".repeat(16385)])(
    "rejects absent, forged, or oversized assertions",
    async (value) => {
      const { env, fetch } = bindings();
      expect((await handleBrowserIngress(request(undefined, value), env, keys)).status).toBe(403);
      expect(fetch).not.toHaveBeenCalled();
    }
  );
  it("rejects a signature from an untrusted key", async () => {
    const pair = await generateKeyPair("RS256");
    const forged = await new SignJWT({ common_name: "gateway.access" })
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setIssuer(issuer)
      .setAudience("browser-audience")
      .setIssuedAt()
      .setExpirationTime("1m")
      .sign(pair.privateKey);
    const { env, fetch } = bindings();
    expect((await handleBrowserIngress(request(undefined, forged), env, keys)).status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("fails closed if key retrieval fails", async () => {
    const { env, fetch } = bindings();
    expect(
      (
        await handleBrowserIngress(request(undefined, await token()), env, async () => {
          throw new Error("unavailable");
        })
      ).status
    ).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["ACCESS_ISSUER", "ACCESS_AUDIENCE", "ACCESS_SERVICE_TOKEN_CLIENT_ID"] as const)(
    "fails closed without %s",
    async (name) => {
      const { env, fetch } = bindings();
      env[name] = "";
      expect(
        (await handleBrowserIngress(request(undefined, await token()), env, keys)).status
      ).toBe(503);
      expect(fetch).not.toHaveBeenCalled();
    }
  );
  it.each([
    "/health",
    "/sessions/test/ws?type=sandbox",
    "/sessions/test/ws?type=client&type=sandbox",
    "/sessions/test/ws?type=unknown",
    "/sessions/test/ws/",
    "/sessions/test/messages",
  ])("does not proxy %s even with valid gateway credentials", async (path) => {
    const { env, fetch } = bindings();
    expect((await handleBrowserIngress(request(path, await token()), env, keys)).status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects non-upgrade and non-GET requests", async () => {
    const { env, fetch } = bindings();
    for (const req of [
      request(undefined, await token(), "POST"),
      new Request("https://ingress.example/sessions/test/ws"),
    ]) {
      expect((await handleBrowserIngress(req, env, keys)).status).toBe(404);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("connection separation", () => {
  it.each([
    ["", true, false],
    ["?type=client", true, false],
    ["?type=sandbox", false, true],
    ["?type=sandbox&type=client", false, false],
    ["?type=sandbox&type=sandbox", false, false],
    ["?type=unknown", false, false],
    ["?type=", false, false],
  ])("classifies %s without overlapping browser/sandbox admission", (query, browser, sandbox) => {
    const req = request(`/sessions/test/ws${query}`);
    expect(isBrowserWebSocketRequest(req)).toBe(browser);
    expect(isSandboxWebSocketRequest(req)).toBe(sandbox);
  });
});
