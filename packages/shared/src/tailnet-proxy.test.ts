import { describe, expect, it } from "vitest";
import {
  evaluateTailnetGate,
  normalizeTailnetProxyToken,
  TAILNET_PROXY_HEADER,
  tailnetGateDeniedResponse,
  withoutTailnetProxyHeader,
} from "./tailnet-proxy";

const TOKEN = "a".repeat(40);

describe("evaluateTailnetGate", () => {
  it("is open when no token is configured", () => {
    expect(evaluateTailnetGate(new Headers(), undefined)).toBe("open");
    expect(evaluateTailnetGate(new Headers(), "")).toBe("open");
    expect(evaluateTailnetGate(new Headers(), "   ")).toBe("open");
  });

  it("allows a request carrying the configured token", () => {
    const headers = new Headers({ [TAILNET_PROXY_HEADER]: TOKEN });
    expect(evaluateTailnetGate(headers, TOKEN)).toBe("allowed");
    expect(evaluateTailnetGate(headers, ` ${TOKEN} `)).toBe("allowed");
  });

  it("denies a request without the header or with a mismatched token", () => {
    expect(evaluateTailnetGate(new Headers(), TOKEN)).toBe("denied");
    const wrong = new Headers({ [TAILNET_PROXY_HEADER]: "b".repeat(40) });
    expect(evaluateTailnetGate(wrong, TOKEN)).toBe("denied");
    const prefix = new Headers({ [TAILNET_PROXY_HEADER]: TOKEN.slice(0, 20) });
    expect(evaluateTailnetGate(prefix, TOKEN)).toBe("denied");
  });
});

describe("normalizeTailnetProxyToken", () => {
  it("trims and treats blank as unset", () => {
    expect(normalizeTailnetProxyToken(undefined)).toBeNull();
    expect(normalizeTailnetProxyToken(" ")).toBeNull();
    expect(normalizeTailnetProxyToken(" abc ")).toBe("abc");
  });
});

describe("tailnetGateDeniedResponse", () => {
  it("is an uncacheable 403", async () => {
    const response = tailnetGateDeniedResponse();
    expect(response.status).toBe(403);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.text()).toBe("Forbidden");
  });
});

describe("withoutTailnetProxyHeader", () => {
  it("removes the proxy header and keeps everything else", () => {
    const request = new Request("https://example.com/x", {
      method: "POST",
      headers: { [TAILNET_PROXY_HEADER]: TOKEN, Cookie: "a=b" },
      body: "payload",
    });
    const stripped = withoutTailnetProxyHeader(request);
    expect(stripped.headers.has(TAILNET_PROXY_HEADER)).toBe(false);
    expect(stripped.headers.get("Cookie")).toBe("a=b");
    expect(stripped.method).toBe("POST");
  });

  it("returns the same request when the header is absent", () => {
    const request = new Request("https://example.com/x");
    expect(withoutTailnetProxyHeader(request)).toBe(request);
  });
});
