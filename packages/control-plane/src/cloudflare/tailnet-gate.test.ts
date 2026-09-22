import { describe, expect, it } from "vitest";
import { TAILNET_PROXY_HEADER } from "@open-inspect/shared/tailnet-proxy";
import { admitWebSocketThroughTailnetGate } from "./tailnet-gate";

const TOKEN = "t".repeat(40);
const WS_PATH = "https://cp.example.com/sessions/s1/ws";

function upgrade(url: string, headers: Record<string, string> = {}): [Request, URL] {
  return [new Request(url, { headers: { Upgrade: "websocket", ...headers } }), new URL(url)];
}

describe("admitWebSocketThroughTailnetGate", () => {
  it("admits everything when no token is configured", () => {
    expect(admitWebSocketThroughTailnetGate(...upgrade(WS_PATH), undefined)).toBe(true);
  });

  it("admits client upgrades that carry the proxy token", () => {
    expect(
      admitWebSocketThroughTailnetGate(
        ...upgrade(WS_PATH, { [TAILNET_PROXY_HEADER]: TOKEN }),
        TOKEN
      )
    ).toBe(true);
  });

  it("refuses client upgrades without the proxy token", () => {
    expect(admitWebSocketThroughTailnetGate(...upgrade(WS_PATH), TOKEN)).toBe(false);
    expect(
      admitWebSocketThroughTailnetGate(
        ...upgrade(WS_PATH, { [TAILNET_PROXY_HEADER]: "wrong" }),
        TOKEN
      )
    ).toBe(false);
  });

  it("admits sandbox upgrades regardless of the proxy token", () => {
    expect(admitWebSocketThroughTailnetGate(...upgrade(`${WS_PATH}?type=sandbox`), TOKEN)).toBe(
      true
    );
  });
});
