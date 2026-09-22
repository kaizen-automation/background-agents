import { describe, expect, it } from "vitest";
import { TAILNET_PROXY_HEADER } from "@open-inspect/shared/tailnet-proxy";
import { admitWebRequestThroughTailnetGate } from "./tailnet-gate";

const TOKEN = "w".repeat(40);

describe("admitWebRequestThroughTailnetGate", () => {
  it("passes requests through untouched when no token is configured", () => {
    const request = new Request("https://web.example.com/sessions");
    const result = admitWebRequestThroughTailnetGate(request, undefined);
    expect(result).toEqual({ admitted: true, request });
  });

  it("admits proxied requests and strips the proxy header", () => {
    const request = new Request("https://web.example.com/api/sessions", {
      headers: { [TAILNET_PROXY_HEADER]: TOKEN, Cookie: "session=abc" },
    });
    const result = admitWebRequestThroughTailnetGate(request, TOKEN);
    expect(result.admitted).toBe(true);
    if (!result.admitted) return;
    expect(result.request.headers.has(TAILNET_PROXY_HEADER)).toBe(false);
    expect(result.request.headers.get("Cookie")).toBe("session=abc");
  });

  it("refuses direct requests to the public hostname", () => {
    for (const path of ["/", "/api/auth/callback/github", "/_next/static/app.js"]) {
      const result = admitWebRequestThroughTailnetGate(
        new Request(`https://web.example.com${path}`),
        TOKEN
      );
      expect(result.admitted).toBe(false);
      if (result.admitted) continue;
      expect(result.response.status).toBe(403);
    }
  });
});
