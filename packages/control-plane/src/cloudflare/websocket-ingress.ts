/** Shared structural checks; sandbox/user authentication still runs in the session. */
function isSessionWebSocket(request: Request): boolean {
  return (
    request.method === "GET" &&
    request.headers.get("Upgrade")?.toLowerCase() === "websocket" &&
    /^\/sessions\/[^/]+\/ws$/.test(new URL(request.url).pathname)
  );
}

export function isSandboxWebSocketRequest(request: Request): boolean {
  const types = new URL(request.url).searchParams.getAll("type");
  return isSessionWebSocket(request) && types.length === 1 && types[0] === "sandbox";
}

export function isBrowserWebSocketRequest(request: Request): boolean {
  // Reject sandbox mode, duplicate modes, and unknown future connection modes.
  const types = new URL(request.url).searchParams.getAll("type");
  return (
    isSessionWebSocket(request) &&
    (types.length === 0 || (types.length === 1 && types[0] === "client"))
  );
}
