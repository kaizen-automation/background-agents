# Tailnet-only browser WebSockets

The web UI is protected separately by its existing hostname-based Cloudflare Access application.
This change protects a browser WebSocket route in the existing control-plane Worker, reusing
Render/Caddy and the gateway's existing service token. No additional Worker, private service
binding, or sandbox gateway credential is needed. OAuth settings are unchanged.

```text
Browser --tailnet--> Render/Caddy --Access service token--> existing control plane
 /_control-plane/sessions/:id/ws       rewrite             /browser/sessions/:id/ws
                                                              |
                                                   verify signed Access JWT
                                                              |
                                                   strip /browser prefix
                                                              |
                                                     session Durable Object

Sandbox --per-sandbox token + ID--> /sessions/:id/ws?type=sandbox --> same session
Web/bots --signed service requests/bindings--> control-plane HTTP API
```

Hostname-based Cloudflare Access protects the control plane's `/browser/*` path. The Worker also
validates the Access JWT signature, issuer, audience, expiry and gateway client ID itself, on every
host (including alternate/preview URLs), before touching session state. It accepts only GET
WebSocket upgrades on `/browser/sessions/:id/ws` with no `type` or exactly `type=client`. It removes
the `/browser` prefix and gateway credentials before forwarding. Missing configuration, invalid
assertions or failed key retrieval fail closed, even before the public-path cutover flag is enabled.
The session still authenticates the user's subscription token and checks permissions; gateway
identity alone does not authorize a user.

With `require_browser_gateway=true`, the public control plane accepts only `type=sandbox` WebSocket
upgrades. Sandbox token, sandbox ID, and lifecycle checks still apply in the session. HTTP routes
retain their existing signed service, per-sandbox or build-callback authentication; `/health`
remains public and returns only service health. This is not a network-level shutdown of the public
Worker.

## Staged CLI rollout

This PR does not activate the feature in `deploy/production.tfvars.json`. Provision and verify the
protected route before closing the old browser path. Use the existing Doppler-backed wrapper from
the repository root; do not put secrets in tfvars.

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
   ```

   Terraform creates a **hostname/path-based** Service Auth application on the existing
   control-plane hostname's `/browser/*` path, not Worker-level Access (which does not support
   WebSockets). The existing Worker receives the application's audience directly from Terraform,
   plus the issuer and client ID. It never receives the service-token secret. Existing UI Access
   configuration is not replaced or imported by this change. If an overlapping control-plane Access
   application already exists, inspect its scope and import/reconcile it before applying; do not
   gate the sandbox/callback routes behind gateway credentials.

3. Deploy the companion Caddy change in `kaizen/contrib/kaizen-code-tailnet-gateway`: it rewrites
   `/_control-plane/sessions/:id/ws` to `/browser/sessions/:id/ws`, preserving query strings and
   injecting the existing Access service token. Keep `CONTROL_PLANE_ORIGIN` unchanged:
   `https://open-inspect-control-plane-kaizen.kaizen-agents.workers.dev`. No Doppler variables need
   to be added or changed. Deploy the control plane and Access application before Caddy. Automatic
   Render deploys are disabled, so deploy the merged gateway revision explicitly.

4. Set `browser_websocket_url` to `wss://inspect-gateway.tail8b645a.ts.net/_control-plane`,
   rebuild/deploy through the wrapper, and verify an authenticated browser session. This value is
   compiled into the web bundle. The GitHub callback change remains a separate prerequisite for
   complete private login; do not declare browser verification complete while that flow still
   returns to the public origin.

5. Set `require_browser_gateway=true`, plan and apply. Verify direct browser upgrades receive 403
   even with forged Access headers; authenticated private browser subscriptions still work; a fresh
   sandbox connects and reports events; missing/wrong/rotated sandbox tokens fail. A successful
   upgrade alone does not prove browser user authentication succeeded.

Preview URLs are disabled for the control plane and web Worker. The control-plane workers.dev URL
stays enabled for sandbox/runtime requests. The web Worker's workers.dev URL stays disabled when its
custom domain is configured.

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

## Rollback

Before closing the public browser path, a failed gateway test requires only fixing or rolling back
Caddy; the old browser transport remains available. After cutover, prefer restoring the last known
working protected deployment. Setting `require_browser_gateway=false` deliberately reopens direct
browser upgrades and should only be an explicit incident decision. Keep the protected `/browser/*`
route and Access configuration while Caddy targets it. Do not remove either underneath the gateway.
