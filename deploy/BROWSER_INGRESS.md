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

## Staged rollout with manually managed Access

Access applications and policies are managed in the Cloudflare dashboard, outside Terraform. The
deployment token does not need any Access administration or discovery permissions. Terraform only
supplies non-secret JWT verification settings to the existing control-plane Worker.

1. Create a **Self-hosted** Access application named `kaizen-code-control-plane` with hostname
   `open-inspect-control-plane-kaizen.kaizen-agents.workers.dev` and path `/browser/*`. Attach only
   the existing gateway **Service Auth** policy. Do not attach the web application's temporary
   allow-all policy, and do not protect the whole control-plane hostname: sandbox sockets and
   callbacks must retain their existing authentication. Disable the App Launcher tile. If this
   application already exists, use it rather than creating a duplicate.

2. Record these non-secret inputs in `deploy/production.tfvars.json`:

   ```json
   {
     "browser_ingress_enabled": true,
     "require_browser_gateway": false,
     "access_team_domain": "https://YOUR-TEAM.cloudflareaccess.com",
     "browser_access_audience": "EXISTING-APPLICATION-AUD",
     "gateway_access_client_id": "EXISTING-CLIENT-ID.access"
   }
   ```

   `browser_access_audience` is the application's 64-character AUD. The client ID is the existing
   `CF_ACCESS_CLIENT_ID` in `kaizen-code-tailnet-gateway/prd`; never copy its secret into tfvars.
   Terraform maps these to `ACCESS_ISSUER`, `ACCESS_AUDIENCE`, and `ACCESS_SERVICE_TOKEN_CLIENT_ID`.
   No Access token UUID or API lookup is needed. Production now specifies these inputs while leaving
   `browser_websocket_url` unset and enforcement off.

3. Prepare and inspect the deployment plan:

   ```bash
   bash deploy/doppler/deploy.sh plan
   ```

   Merging a configuration PR triggers the existing production Terraform apply automatically.
   Coordinate that merge with active users: even with enforcement disabled, redeploying Workers can
   interrupt sockets. For an explicitly coordinated manual deployment, use
   `bash deploy/doppler/deploy.sh apply`.

4. The companion Caddy rewrite (kaizen PR #12530) is already deployed on Render. Keep
   `CONTROL_PLANE_ORIGIN` unchanged. Test the private `/browser/*` route via the gateway, verify
   direct unsigned/forged requests fail, and verify sandbox callbacks/connections still work. A
   successful socket upgrade alone does not prove user authentication: test a valid authenticated
   subscription and a denied subscription using a separate test session.

5. When ready to move users, finish the private OAuth callback setup, set `browser_websocket_url` to
   `wss://inspect-gateway.tail8b645a.ts.net/_control-plane`, and rebuild/deploy the web bundle.
   Verify login, session actions, and authenticated WebSocket updates before removing the web
   application's temporary allowance and enabling `require_browser_gateway=true`. Until enforcement
   is enabled, the original direct browser socket route remains available.

Preview URLs are disabled for the control plane and web Worker. The control-plane workers.dev URL
stays enabled for sandbox/runtime requests. The web Worker's workers.dev URL stays disabled when its
custom domain is configured.

### Existing Terraform-managed Access deployments

Kaizen never enabled the previous Access resources, so its state has no such resources to remove.
For any other deployment that did enable them, remove those resources from Terraform ownership
without deleting the live application/policy before applying this version, and supply the retained
application's AUD. Inspect the plan: it must not destroy Access protections. Do not run a blanket
apply that deletes an application still used by the gateway.

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

### Login-origin cutover

Register `https://inspect-gateway.tail8b645a.ts.net/api/auth/callback/github` as an additional
GitHub App redirect URI before deploying the Kaizen login-origin change. Keep the public callback
during rollback readiness. `browser_web_origin` sets the control plane's `WEB_APP_URL`, which Better
Auth uses for its base URL, trusted origin, and host-only cookies. It does not change the Cloudflare
custom domain or Caddy upstream. Users must sign in again at the gateway; public-origin sign-in and
other auth actions may stop working. Coordinate this deployment with active users.

After deployment, sign in from the gateway and verify the callback returns there, then open a test
session. This change does not switch the browser WebSocket URL, enforce gateway-only sockets, or
remove the temporary web Access policy. Those are separate cutover steps. To roll back the login
origin, remove `browser_web_origin` from production tfvars and redeploy; retain the public GitHub
callback until the cutover is verified.

### Browser WebSocket cutover

Kaizen production sets `browser_websocket_url` to
`wss://inspect-gateway.tail8b645a.ts.net/_control-plane`. Deployment rebuilds the web bundle with
this URL in `NEXT_PUBLIC_WS_URL`; existing tabs must reload to receive it. Users need Tailscale
connectivity. Open the gateway, complete GitHub sign-in, and open a test session. In browser Network
tools, verify its WebSocket uses the gateway `/_control-plane/sessions/<id>/ws` route, upgrades
successfully, and receives `subscribed`. The earlier console probe alone does not verify the rebuilt
app.

`require_browser_gateway` remains false during this check, and the temporary web Access policy
remains unchanged. Old tabs may still use the direct socket until reloaded. Coordinate a later
enforcement change with active users. To roll back only socket transport, remove
`browser_websocket_url` and redeploy/reload; the private login origin remains configured.

### Custom-domain cutover to code.kaizenautomation.dev

Production uses `browser_web_origin=https://code.kaizenautomation.dev` and
`browser_websocket_url=wss://code.kaizenautomation.dev/_control-plane`. The first sets the control
plane's auth base/trusted origin and generated web links; the second is compiled into the web client
at deployment. Neither changes the Cloudflare upstream domain or sandbox callback URLs. Gateway
enforcement remains enabled.

Before deploying these values:

1. Merge kaizen monorepo PR #12543 and manually deploy its gateway image while `GATEWAY_HOSTNAME`
   remains unset, preserving the old hostname initially.
2. Register `https://code.kaizenautomation.dev/api/auth/callback/github` in the GitHub App. Retain
   the old tailnet callback during rollout.
3. Verify the DNS-only A record points to the gateway's Tailscale IP and the gateway Doppler config
   contains its scoped `CF_DNS_API_TOKEN`.
4. Coordinate with active users, then set `GATEWAY_HOSTNAME=code.kaizenautomation.dev` in gateway
   Doppler and deploy. This replaces the old ts.net listener. Verify
   `curl -I https://code.kaizenautomation.dev/` succeeds over Tailscale without `-k`.
5. Merge/deploy this app URL change immediately afterward. Expect an interruption between the
   gateway and app deployments; users must reload and sign in again.

Verify GitHub returns to the new hostname and a normal session's WebSocket uses
`wss://code.kaizenautomation.dev/_control-plane/sessions/<id>/ws` and receives `subscribed`. Direct
public access must remain blocked. Remove the old GitHub callback after verification. Do not change
Access policies or the Caddy upstreams.

Rollback requires both sides: unset `GATEWAY_HOSTNAME` and redeploy the gateway, then restore the
previous ts.net browser origin/socket URL and redeploy the app. Keep the previous GitHub callback
until the custom-domain cutover is confirmed.
