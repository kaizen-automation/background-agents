import { initSession, seedSandboxAuth } from "./helpers";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../../src/index";
import { importJWK, SignJWT } from "jose";
import type { WorkerBindings } from "../../src/cloudflare/platform";

const bindings = () =>
  ({
    ...env,
    REQUIRE_BROWSER_GATEWAY: "true",
    ACCESS_ISSUER: "https://test.cloudflareaccess.com",
    ACCESS_AUDIENCE: "browser-test",
    ACCESS_SERVICE_TOKEN_CLIENT_ID: "gateway.access",
  }) as unknown as WorkerBindings;
function socket(path = "/sessions/missing/ws") {
  return new Request(`https://public.example${path}`, { headers: { Upgrade: "websocket" } });
}

describe("Cloudflare browser ingress boundary", () => {
  it.each(["public.example", "alternate.workers.dev", "preview.workers.dev"])(
    "requires signed gateway identity on %s even before cutover",
    async (host) => {
      for (const assertion of [undefined, "forged"]) {
        const req = new Request(`https://${host}/browser/sessions/missing/ws`, {
          headers: {
            Upgrade: "websocket",
            ...(assertion ? { "Cf-Access-Jwt-Assertion": assertion } : {}),
          },
        });
        const ctx = createExecutionContext();
        expect(
          (await worker.fetch(req, { ...bindings(), REQUIRE_BROWSER_GATEWAY: "false" }, ctx)).status
        ).toBe(403);
        await waitOnExecutionContext(ctx);
      }
    }
  );
  it("verifies Access and rewrites the browser path to an existing session", async () => {
    const { sessionName } = await initSession();
    const ctx = createExecutionContext();
    const key = await importJWK(
      JSON.parse((env as unknown as { TEST_ACCESS_PRIVATE_JWK: string }).TEST_ACCESS_PRIVATE_JWK),
      "RS256"
    );
    const jwt = await new SignJWT({ common_name: "gateway.access" })
      .setProtectedHeader({ alg: "RS256", kid: "integration" })
      .setIssuer("https://test.cloudflareaccess.com")
      .setAudience("browser-test")
      .setIssuedAt()
      .setExpirationTime("1m")
      .sign(key);
    const req = socket(`/browser/sessions/${sessionName}/ws?type=client`);
    req.headers.set("Cf-Access-Jwt-Assertion", jwt);
    const response = await worker.fetch(req, bindings(), ctx);
    expect(response.status).toBe(101);
    response.webSocket!.accept();
    response.webSocket!.close();
    await waitOnExecutionContext(ctx);
  });
  it.each([true, false])(
    "preserves sandbox authentication on public ingress (valid=%s)",
    async (valid) => {
      const { stub, sessionName } = await initSession();
      await seedSandboxAuth(stub, { authToken: "synthetic-token", sandboxId: "sb-test" });
      const req = socket(`/sessions/${sessionName}/ws?type=sandbox`);
      req.headers.set("Authorization", `Bearer ${valid ? "synthetic-token" : "wrong-token"}`);
      req.headers.set("X-Sandbox-ID", "sb-test");
      const ctx = createExecutionContext();
      const response = await worker.fetch(req, bindings(), ctx);
      expect(response.status).toBe(valid ? 101 : 401);
      if (response.webSocket) {
        response.webSocket.accept();
        response.webSocket.close();
      }
      await waitOnExecutionContext(ctx);
    }
  );
  it("rejects direct browser upgrades before touching session state", async () => {
    for (const query of ["", "?type=client", "?type=sandbox&type=client"]) {
      const ctx = createExecutionContext();
      const response = await worker.fetch(socket(`/sessions/missing/ws${query}`), bindings(), ctx);
      expect(response.status).toBe(403);
      await waitOnExecutionContext(ctx);
    }
  });
  it("does not trust forged gateway headers on the public entrypoint", async () => {
    const req = socket();
    req.headers.set("Cf-Access-Jwt-Assertion", "forged");
    req.headers.set("X-OpenInspect-Tailnet-Proxy", "true");
    const ctx = createExecutionContext();
    expect((await worker.fetch(req, bindings(), ctx)).status).toBe(403);
    await waitOnExecutionContext(ctx);
  });
  it("the browser namespace rejects sandbox sockets and HTTP APIs", async () => {
    const ctx = createExecutionContext();
    expect(
      (await worker.fetch(socket("/browser/sessions/missing/ws?type=sandbox"), bindings(), ctx))
        .status
    ).toBe(404);
    expect(
      (await worker.fetch(new Request("https://internal/browser/sessions"), bindings(), ctx)).status
    ).toBe(404);
    await waitOnExecutionContext(ctx);
  });
});
