# Tailnet-only browser WebSockets

The web UI is protected separately by its existing hostname-based Cloudflare Access application.
This change adds a small browser WebSocket Worker and an Access application for it, reusing the
Render gateway's existing service token. No sandbox receives that token or joins the tailnet. OAuth
settings are unchanged.

```text
Browser --tailnet--> Render/Caddy --Access service token--> browser ingress
                                                            |
                                                  private service binding
                                                            |
                                              BrowserWebSocketEntrypoint
                                                            |
                                                     session Durable Object

Sandbox --per-sandbox token + ID--> public control plane --> session Durable Object
Web/bots --signed service requests/bindings--> control-plane HTTP API
```

The browser ingress accepts only GET WebSocket upgrades on `/sessions/:id/ws` with no `type` or
`type=client`. It validates the Access JWT signature, issuer, audience, expiry and service-token
client ID, then strips gateway credentials before forwarding. Missing/broken configuration or key
retrieval fails closed. The private named entrypoint repeats the route/type checks. It is not
selectable through a public URL or a spoofed header. The session still authenticates the user's
subscription token and checks permissions.

With `require_browser_gateway=true`, the public control plane accepts only `type=sandbox` WebSocket
upgrades. Sandbox token, sandbox ID, and lifecycle checks still apply in the session. HTTP routes
retain their existing signed service, per-sandbox or build-callback authentication; `/health`
remains public and returns only service health. This is not a network-level shutdown of the public
Worker.

## Staged CLI rollout

This PR does not activate the feature in `deploy/production.tfvars.json`. Provision and verify the
new entrypoint before closing the old browser path. Use the existing Doppler-backed wrapper from the
repository root; do not put secrets in tfvars.

1. Find the Access team URL, existing gateway service-token UUID and bare client ID. These three
   values are non-secret. Confirm the token is in the Cloudflare account managed by this Terraform
   deployment; do not create a second token just because an account-scoped listing doesn't show a
   zone-scoped resource. The API credential needs Access applications/policies write and
   service-token read permissions in addition to its existing deployment permissions.

2. Add these non-secret inputs to `deploy/production.tfvars.json` (replace examples):

   ```json
   {
     "browser_ingress_enabled": true,
     "require_browser_gateway": false,
     "access_team_domain": "https://YOUR-TEAM.cloudflareaccess.com",
     "gateway_access_service_token_id": "EXISTING-TOKEN-UUID",
     "gateway_access_client_id": "EXISTING-CLIENT-ID.access"
   }
   ```

   Leave `browser_websocket_url` unset for this provisioning phase. Run:

   ```bash
   bash deploy/doppler/deploy.sh plan
   bash deploy/doppler/deploy.sh apply
   bash deploy/doppler/deploy.sh output -raw browser_ingress_url
   ```

   Terraform creates a **hostname-based** Service Auth application, not Worker-level Access (which
   currently does not support WebSockets). The new Worker receives the application's audience
   directly from Terraform, plus the issuer and client ID. It never receives the service-token
   secret. Existing UI Access configuration is not replaced or imported by this change.

3. Set `CONTROL_PLANE_ORIGIN` in `kaizen-code-tailnet-gateway/prd` to the output URL. For this
   deployment the expected URL is
   `https://open-inspect-browser-ingress-kaizen.kaizen-agents.workers.dev`:

   ```bash
   doppler secrets set --project kaizen-code-tailnet-gateway --config prd \
     CONTROL_PLANE_ORIGIN=https://open-inspect-browser-ingress-kaizen.kaizen-agents.workers.dev
   ```

   Let the existing Doppler-to-Render sync deploy it. The Caddy routing/configuration does not need
   a code change.

4. Set `browser_websocket_url` to `wss://inspect-gateway.tail8b645a.ts.net/_control-plane`,
   rebuild/deploy through the wrapper, and verify an authenticated browser session. This value is
   compiled into the web bundle. The GitHub callback change remains a separate prerequisite for
   complete private login; do not declare browser verification complete while that flow still
   returns to the public origin.

5. Set `require_browser_gateway=true`, plan and apply. Verify direct browser upgrades receive 403
   even with forged Access headers; authenticated private browser subscriptions still work; a fresh
   sandbox connects and reports events; missing/wrong/rotated sandbox tokens fail. A successful
   upgrade alone does not prove browser user authentication succeeded.

Preview URLs are disabled for the control plane, browser ingress, and web Worker. The control-plane
workers.dev URL stays enabled for sandbox/runtime requests. The web Worker's workers.dev URL stays
disabled when its custom domain is configured.

## Local validation

```bash
npm ci --ignore-scripts
npm run build -w @open-inspect/shared
npm test -w @open-inspect/control-plane -- src/cloudflare/browser-ingress.test.ts
npm run test:integration -w @open-inspect/control-plane -- test/integration/browser-ingress.test.ts
npm run typecheck -w @open-inspect/control-plane
npm run build:worker -w @open-inspect/control-plane
terraform -chdir=terraform/environments/production init -backend=false
terraform -chdir=terraform/environments/production validate
terraform -chdir=terraform/environments/production test -filter=tests/browser_ingress.tftest.hcl
```

Integration tests need permission to bind local loopback ports. The rollout checks above require
live Access and Render; local tests do not establish live enforcement.
