// Worker entrypoint: the tailnet ingress gate in front of the OpenNext bundle.
// `TAILNET_PROXY_TOKEN` is a Worker secret; when it is unset the gate is open
// and this module behaves exactly like `.open-next/worker.js`.
import openNextWorker from "../.open-next/worker.js";
import { admitWebRequestThroughTailnetGate } from "../src/lib/tailnet-gate";

export * from "../.open-next/worker.js";

export default {
  ...openNextWorker,
  async fetch(request, env, ctx) {
    const gate = admitWebRequestThroughTailnetGate(request, env.TAILNET_PROXY_TOKEN);
    if (!gate.admitted) return gate.response;
    return openNextWorker.fetch(gate.request, env, ctx);
  },
};
