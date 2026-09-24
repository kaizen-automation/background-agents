import { initSession, seedSandboxAuth } from "./helpers";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker, { BrowserWebSocketEntrypoint } from "../../src/index";
import type { WorkerBindings } from "../../src/cloudflare/platform";

const bindings = () => ({ ...env, REQUIRE_BROWSER_GATEWAY: "true" }) as unknown as WorkerBindings;
function socket(path = "/sessions/missing/ws") {
  return new Request(`https://public.example${path}`, { headers: { Upgrade: "websocket" } });
}

describe("Cloudflare browser ingress boundary", () => {
  it("allows private browser upgrades while the public entrypoint is closed", async () => {
    const { sessionName } = await initSession();
    const ctx = createExecutionContext();
    const entrypoint = new BrowserWebSocketEntrypoint(ctx, bindings());
    const response = await entrypoint.fetch(socket(`/sessions/${sessionName}/ws`));
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
  it("the private named entrypoint cannot be used for sandbox sockets or HTTP APIs", async () => {
    const ctx = createExecutionContext();
    const entrypoint = new BrowserWebSocketEntrypoint(ctx, bindings());
    expect((await entrypoint.fetch(socket("/sessions/missing/ws?type=sandbox"))).status).toBe(404);
    expect((await entrypoint.fetch(new Request("https://internal/sessions"))).status).toBe(404);
    await waitOnExecutionContext(ctx);
  });
});
