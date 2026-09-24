# Open-Inspect — Kaizen production deployment

Internal deployment of Open-Inspect for the engineering team. This directory holds the
Doppler-backed deployment wrapper and the non-secret Terraform inputs; everything else is upstream
Terraform under `terraform/environments/production`.

```
                 GitHub App OAuth (org members only)
  engineer ─────────────────────────────────────────────┐
     │  https://agents.kaizenautomation.dev  (Cloudflare custom domain)
     ▼
┌────────────────────┐   service binding   ┌──────────────────────────────┐
│ web Worker         │────────────────────▶│ control-plane Worker         │
│ (Next.js/OpenNext) │◀── WebSocket ───────│ Durable Objects (SQLite/sess)│
└────────────────────┘                     │ D1 · KV · R2 · Queues        │
                                           └──────────┬───────────────────┘
                                 MODAL_API_SECRET      │  installation token
                                                       ▼        (GitHub App,
                                           ┌──────────────────────┐ selected repos)
                                           │ Modal app open-inspect│──────▶ GitHub
                                           │  sandbox: Claude Agent│
                                           │  SDK + repo checkout  │──────▶ Amazon Bedrock (us-west-2)
                                           └──────────────────────┘
Doppler kaizen-code/prd  ──(deploy time only)──▶ TF_VAR_* ──▶ Worker secrets · Modal secrets
```

## Secrets

Doppler project `kaizen-code`, config `prd`, is the only place secrets live. The wrapper
`deploy/doppler/deploy.sh` runs `doppler run --no-fallback` and maps each Doppler secret to the
`TF_VAR_*` (or backend) environment variable that upstream Terraform already consumes. No tfvars
file, fallback cache, or command-line argument ever carries a secret value.

| Doppler secret                                                                     | Consumer                                    | Runtime variable / use                                           |
| ---------------------------------------------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------- |
| `CLOUDFLARE_ACCOUNT_ID`                                                            | Terraform provider, wrangler                | account for all Cloudflare resources                             |
| `CLOUDFLARE_API_TOKEN`                                                             | Terraform provider, wrangler                | scoped token (see below)                                         |
| `CLOUDFLARE_ZONE_ID`                                                               | Terraform                                   | zone `kaizenautomation.dev`                                      |
| `CLOUDFLARE_WORKER_SUBDOMAIN`                                                      | Terraform                                   | `kaizen-agents` → control-plane `*.workers.dev`                  |
| `CLOUDFLARE_CUSTOM_DOMAIN`                                                         | Terraform                                   | `agents.kaizenautomation.dev` (web Worker)                       |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`                                         | Terraform S3 backend                        | state in R2 bucket `open-inspect-terraform-state`                |
| `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET`                                             | Terraform → `modal` CLI                     | deploy Modal app + secrets                                       |
| `MODAL_WORKSPACE` (+ optional `MODAL_ENVIRONMENT`, `MODAL_ENVIRONMENT_WEB_SUFFIX`) | Terraform                                   | Modal endpoint URLs                                              |
| `MODAL_PROXY_NAME` (optional)                                                      | Modal secret `internal-api`                 | Modal Proxy every sandbox egresses through (static IPs)          |
| `AWS_BEARER_TOKEN_BEDROCK`                                                         | Modal secret `llm-api-keys`                 | sandbox `AWS_BEARER_TOKEN_BEDROCK` + `CLAUDE_CODE_USE_BEDROCK=1` |
| `AWS_REGION`                                                                       | Modal secret `llm-api-keys`                 | sandbox `AWS_REGION` (Bedrock endpoint region)                   |
| `ANTHROPIC_API_KEY` (alternative to the two above)                                 | Modal secret `llm-api-keys`                 | sandbox `ANTHROPIC_API_KEY` (Claude harness)                     |
| `AZURE_OPENAI_API_KEY` (optional)                                                  | Modal secret `llm-api-keys`                 | sandbox `AZURE_API_KEY` (OpenCode harness, `azure/*` models)     |
| `GITHUB_APP_ID`                                                                    | Worker secret + Modal secret `github-app`   | `GITHUB_APP_ID`                                                  |
| `GITHUB_APP_PRIVATE_KEY` (PKCS#8)                                                  | Worker secret + Modal secret `github-app`   | `GITHUB_APP_PRIVATE_KEY`                                         |
| `GITHUB_APP_INSTALLATION_ID`                                                       | Worker secret + Modal secret `github-app`   | `GITHUB_APP_INSTALLATION_ID`                                     |
| `GITHUB_CLIENT_ID`                                                                 | Worker var                                  | GitHub sign-in                                                   |
| `GITHUB_CLIENT_SECRET`                                                             | Worker secret                               | `GITHUB_CLIENT_SECRET`                                           |
| `ALLOWED_GITHUB_ORGS`                                                              | Worker var                                  | admission: active members of these orgs                          |
| `NEXTAUTH_SECRET`                                                                  | Worker secret                               | `BROWSER_AUTH_SECRET` (session cookies)                          |
| `TOKEN_ENCRYPTION_KEY`                                                             | Worker secret                               | encrypts per-user GitHub tokens                                  |
| `REPO_SECRETS_ENCRYPTION_KEY`                                                      | Worker secret                               | encrypts Settings → Secrets in D1                                |
| `PROVIDER_ACCOUNTS_ENCRYPTION_KEY`                                                 | Worker secret                               | encrypts provider accounts — never change                        |
| `MODAL_API_SECRET`                                                                 | Worker secret + Modal secret `internal-api` | control plane ↔ Modal auth                                       |

Generated secrets are 32 random bytes, base64 (`openssl rand -base64 32`), created straight into
Doppler with `doppler secrets set NAME="$(openssl rand -base64 32)" --silent`.

### Model provider: Amazon Bedrock

The Claude harness runs Claude Code, which speaks to Bedrock natively when
`CLAUDE_CODE_USE_BEDROCK=1`. This fork adds a Bedrock credential mode to
`packages/sandbox-runtime/.../harness/claude_env.py` (upstream only accepts `ANTHROPIC_API_KEY`);
the model ids in the UI (`anthropic/claude-*`) are passed to Claude Code, which maps them to Bedrock
inference profiles itself. Bedrock only knows dated snapshot ids for Haiku/Sonnet/Opus 4.5, so in
Bedrock mode the harness pins those three (`BEDROCK_MODEL_SNAPSHOTS`, now in `harness/bedrock.py`).

OpenCode sessions use Bedrock in this mode too: the sandbox's generated opencode.json
(`opencode_model_config.py`) points `model` at OpenCode's built-in `amazon-bedrock` provider
(`@ai-sdk/amazon-bedrock`, bundled in the pinned OpenCode — no runtime npm fetch) with
`provider.amazon-bedrock.options.region = $AWS_REGION`, and per-prompt model switches are translated
the same way. The control plane still sees the catalog id; only the id handed to OpenCode changes.
OpenCode prefixes the regional inference profile itself (`us.` for `us-*` regions):

| Catalog model (`anthropic/…`) | OpenCode id (`amazon-bedrock/…`)            | Bedrock request                                |
| ----------------------------- | ------------------------------------------- | ---------------------------------------------- |
| `claude-sonnet-4-6`           | `anthropic.claude-sonnet-4-6`               | `us.anthropic.claude-sonnet-4-6`               |
| `claude-opus-4-7`             | `anthropic.claude-opus-4-7`                 | `us.anthropic.claude-opus-4-7`                 |
| `claude-sonnet-5`             | `anthropic.claude-sonnet-5`                 | `us.anthropic.claude-sonnet-5`                 |
| `claude-opus-4-6`             | `anthropic.claude-opus-4-6-v1`              | `us.anthropic.claude-opus-4-6-v1`              |
| `claude-haiku-4-5`            | `anthropic.claude-haiku-4-5-20251001-v1:0`  | `us.anthropic.claude-haiku-4-5-20251001-v1:0`  |
| `claude-sonnet-4-5`           | `anthropic.claude-sonnet-4-5-20250929-v1:0` | `us.anthropic.claude-sonnet-4-5-20250929-v1:0` |
| `claude-opus-4-5`             | `anthropic.claude-opus-4-5-20251101-v1:0`   | `us.anthropic.claude-opus-4-5-20251101-v1:0`   |
| any other `claude-*`          | `anthropic.<model>`                         | `us.anthropic.<model>`                         |

Model status on account `083880123012` / `us-west-2` (probed 2026-09-20 with Claude Code):

| Catalog model                                                       | Bedrock                                                                                                                                                                                           |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sonnet 4.6 · Opus 4.6 · Opus 4.7 · Sonnet 5 · Haiku/Sonnet/Opus 4.5 | works                                                                                                                                                                                             |
| Opus 4.8 · Opus 5                                                   | 403 until the account subscribes: add `aws-marketplace:ViewSubscriptions` + `aws-marketplace:Subscribe` to the key's IAM user once, or invoke each model once from the Bedrock console playground |
| Fable 5 · Fable 5.1                                                 | rejected — "data retention mode `default` is not available"; needs the model's data-retention opt-in in the Bedrock console, otherwise hide them under Settings → Models                          |

- Exactly one of `AWS_BEARER_TOKEN_BEDROCK` / `ANTHROPIC_API_KEY` may be set in Doppler; `check`
  enforces it. With Bedrock, `AWS_REGION` is required (currently `us-west-2`).
- The key: AWS Console → IAM → _API keys for Bedrock_ → Generate → **Long-term**, attached to a
  dedicated IAM user whose policy allows only `bedrock:InvokeModel`,
  `bedrock:InvokeModelWithResponseStream`, `bedrock:ListInferenceProfiles`,
  `bedrock:GetInferenceProfile` on `inference-profile/*` and `foundation-model/*`. Anthropic model
  access must be enabled once per account (Bedrock → Model catalog → use-case form). The user must
  carry no IP-conditioned policy: sandboxes call Bedrock from Modal's egress IPs. If a network
  restriction is ever required, Modal Proxies (workspace Settings → Proxies, Team plan+) give
  sandboxes static IPs to allowlist, at the cost of passing `proxy=modal.Proxy.from_name(...)` to
  `Sandbox.create` in `packages/modal-infra` — not done here.
- The key reaches only Modal sandboxes (Terraform test `tests/bedrock_api_key.tftest.hcl` pins that
  the control plane never binds it). In the sandbox the harness passes it to Claude Code and strips
  every Anthropic-API / OAuth credential, and vice versa (`tests/test_claude_env.py`).
- Switching back to the Anthropic API: clear `AWS_BEARER_TOKEN_BEDROCK`, set `ANTHROPIC_API_KEY`,
  `apply`. The Modal secret keeps every name with an empty value so the old credential is reconciled
  away.

### Model provider: Azure OpenAI (OpenCode harness)

The OpenCode harness can run OpenAI models through the company's Azure OpenAI (Azure AI Foundry)
resource instead of api.openai.com. OpenCode's built-in `azure` provider authenticates with
`AZURE_API_KEY` and targets `https://<AZURE_RESOURCE_NAME>.openai.azure.com/`; the sandbox pins the
resource name in the generated opencode.json (`provider.azure.options.resourceName`,
`build_azure_provider_config` in `packages/sandbox-runtime/.../opencode_server.py`). Azure models
live under their own catalog group ("Azure OpenAI" in Settings → Models: `azure/gpt-6-astra`,
`azure/gpt-5.6-sol`, `azure/gpt-5.6-terra`, `azure/gpt-6-sol`, `azure/gpt-6-luna`); the existing
`openai/*` entries keep going to api.openai.com.

- Doppler: `AZURE_OPENAI_API_KEY` (a key of the Azure OpenAI resource, Foundry portal → resource →
  Keys and Endpoint). The resource name is not a secret and lives in code:
  `azure_openai_resource_name` in `deploy/production.tfvars.json` (the `<RESOURCE_NAME>` in
  `https://<RESOURCE_NAME>.openai.azure.com/`, currently `kaizen-openai`, eastus). Both or neither;
  `check` enforces it, as does the Terraform validation on `azure_openai_resource_name`. Both reach
  only Modal sandboxes (`tests/azure_openai.tftest.hcl`). Independent of the Claude harness's
  Bedrock/Anthropic credential.
- **Deployment name must equal the model name.** OpenCode addresses Azure deployments by the model
  id, so before enabling an `azure/<model>` entry create a deployment named exactly `<model>` in the
  Foundry resource: `gpt-6-astra` (model `gpt-6-astra`) for `azure/gpt-6-astra`, `gpt-5.6-sol`
  (model `gpt-5.6-sol`) for `azure/gpt-5.6-sol`, `gpt-5.6-terra` for `azure/gpt-5.6-terra`,
  `gpt-6-sol` / `gpt-6-luna` (model version 2026-09-22) for `azure/gpt-6-sol` / `azure/gpt-6-luna`.
  Any further `azure/<model>` catalog entry needs a same-named deployment as well. The resource is
  global (`azure_openai_resource_name`), not per model, so every allowlisted `azure/*` model must be
  deployed on that one resource, and `AZURE_OPENAI_API_KEY` must be a key of that same resource — a
  key from another resource fails with "invalid subscription key or wrong API endpoint". Quota for
  these models is pooled per subscription, so a second resource (`kaizen-openai-westus3` holds small
  copies of the same deployments) competes with `kaizen-openai` for capacity.
- Then expose the model: append the canonical id (`azure/gpt-6-astra`, `azure/gpt-5.6-sol`, ...) to
  `model_allowlist` in `deploy/production.tfvars.json` (the deployment allowlist, `MODEL_ALLOWLIST`)
  and `apply`. Until then the model stays hidden; once allowlisted it is enabled by default
  (Settings → Models only needed to turn it off). Sessions pick it by its `azure/...` id on the
  OpenCode harness; the Claude harness cannot run it.
- Removing Azure: clear the Doppler key, blank `azure_openai_resource_name` and `apply` (the Modal
  secret keeps both names with empty values) and drop the `azure/*` ids from `model_allowlist`.

### Model & harness allowlist

`deploy/production.tfvars.json` pins what this deployment may run:

- `harness_allowlist = ["opencode"]` — OpenCode is the only agent; the web UI hides the Agent picker
  and the control plane rejects `harness: claude` on every path.
- `model_allowlist` — the Bedrock-verified Claude models (Sonnet 4.6, Opus 4.7, Sonnet 5) plus
  `azure/gpt-6-astra`, `azure/gpt-5.6-sol`, `azure/gpt-5.6-terra`, `azure/gpt-6-sol` and
  `azure/gpt-6-luna` (same-named deployments on `azure_openai_resource_name` = `kaizen-openai`).

Terraform joins the lists into the control-plane bindings `MODEL_ALLOWLIST` / `HARNESS_ALLOWLIST`
(`packages/control-plane/src/deployment-catalog.ts`). `GET /model-preferences` returns them as
`availableModels` / `availableHarnesses`, which is what the picker, Settings → Models and the
automation form render; persisted preferences are narrowed to the allowlist on read. Session create,
child spawn, automation create/update and queued-message dispatch all reject anything outside it
(HTTP 400), so nothing reaches a sandbox without credentials. Empty lists mean "whole shared
catalog", so both must stay set. To enable another model (e.g. after the Opus 4.8 Marketplace
subscription), verify it against Bedrock first, then add its canonical id and `apply 2`.

Every allowlisted model is enabled by default (`defaultEnabledModels` in `deployment-catalog.ts`),
so `apply 2` is enough for a new entry to show up in the picker; the shared catalog's
`enabledByDefault` flags only apply when no `model_allowlist` is set. Settings → Models still lets
someone switch an allowlisted model off (stored in D1 `model_preferences`), and that choice wins
over the default until it is toggled back.

### Cloudflare API token (least privilege)

Account: Workers Scripts Edit · Workers KV Storage Edit · D1 Edit · Queues Edit · Account Settings
Read. Zone (only `kaizenautomation.dev`): Workers Routes Edit. Nothing else — in particular:

- **No R2 permission.** The account holds unrelated R2 buckets, so the media bucket
  `open-inspect-media` is created out-of-band and Terraform only binds it
  (`r2_media_bucket_managed = false`, `r2_media_bucket_name = "open-inspect-media"` in
  `production.tfvars.json`; `tests/external_media_bucket.tftest.hcl`). Attaching an R2 binding is a
  Worker-script operation, so Workers Scripts Edit suffices. Terraform state lives in a separate
  bucket reached through S3 credentials scoped to that bucket alone (`R2_*`).
- **No DNS permission.** `agents.kaizenautomation.dev` is a Workers Custom Domain
  (`PUT /accounts/{id}/workers/domains`): Cloudflare creates the proxied DNS record and edge
  certificate itself, and the documented requirement is Zone → Workers Routes Write on the zone, not
  DNS Write. Do not pre-create a DNS record for the hostname — an existing CNAME blocks the Custom
  Domain.

Probe the token without printing it:
`deploy/doppler/deploy.sh run bash -c 'curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/domains | jq .success'`
(expect `true`); the same call against `/r2/buckets` must return an authentication error.

### GitHub App permissions

Repository: Contents R/W · Pull requests R/W · Metadata Read. Organization: Members Read (org
admission). Installed with **Only select repositories**. Webhook inactive (GitHub bot disabled).

### What reaches a sandbox

Only the model credential (`AWS_BEARER_TOKEN_BEDROCK` + `AWS_REGION`, from a Bedrock-only IAM user
with an AWS Budgets alert — or `ANTHROPIC_API_KEY` from a capped workspace), a per-session sandbox
token, and a short-lived GitHub installation token. Production application credentials are never
present unless someone deliberately adds them under Settings → Secrets.

## Deploying

```bash
export DOPPLER_TOKEN=...              # read-only service token for kaizen-code/prd
deploy/doppler/deploy.sh check        # tooling + secret names (no values)
deploy/doppler/deploy.sh bootstrap    # R2 state bucket + terraform init
deploy/doppler/deploy.sh apply 1      # phase 1: bindings off
deploy/doppler/deploy.sh apply 2      # phase 2: DO + service bindings on
deploy/doppler/deploy.sh output
```

Later changes: `deploy/doppler/deploy.sh plan` / `apply` (phase 2 is the default). The wrapper
builds `@open-inspect/shared` and the Worker bundles first (Terraform reads `dist/index.js` at plan
time); Terraform then builds the OpenNext web bundle, applies D1 migrations, and deploys the Modal
app (`packages/modal-infra/deploy.py`, sandbox image build included), so `node` 22, `npm`, `uv`,
`jq`, `terraform` (>= 1.14, per `versions.tf`) and `doppler` must be on `PATH`. Wrangler and the
Modal CLI come from the repository's own dependencies (`npm install`, and `uv sync --frozen` in
`packages/modal-infra`).

After the initial bootstrap, `.github/workflows/deploy-production.yml` automates later changes: pull
requests into `main` run `deploy.sh plan`, and pushes to `main` run
`deploy.sh apply 2 -auto-approve`. It needs a single GitHub Actions secret, `DOPPLER_TOKEN` (the
same read-only service token used above); everything else is read from Doppler at run time. A push
to `main` without that secret fails the workflow (nothing is deployed); pull requests without it
(e.g. from forks) skip the plan with a notice.

After the first deploy, bootstrap the workspace Owner (upstream Step 7a):

```bash
deploy/doppler/deploy.sh run npm run rbac:bootstrap-owner -- --database <d1_database_name> --user <user-id> --execute
```

## Limits

| Limit                              | Where                                              | Value                   |
| ---------------------------------- | -------------------------------------------------- | ----------------------- |
| Concurrent child sessions per task | Settings → Sandbox → `maxConcurrentChildSessions`  | 4                       |
| Total child sessions per task      | Settings → Sandbox → `maxTotalChildSessions`       | 8                       |
| Child nesting depth                | hard-coded upstream (`MAX_SPAWN_DEPTH`)            | 2                       |
| Per-session spend                  | Settings → Sandbox → `maxSessionCostUsd`           | 15                      |
| Sandbox size / lifetime            | Settings → Sandbox                                 | 2 vCPU · 4096 MiB · 2 h |
| Total model spend                  | AWS Budgets (Bedrock) / Anthropic workspace limits | monthly cap + alert     |
| Total sandboxes                    | Modal workspace resource limits                    | see Modal settings      |

Claude Code sub-agents (`Agent` tool) run inside the parent sandbox and finish within the turn
(`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` is forced by the harness); they are bounded by the
per-session spend limit, not a count.

## Runbooks

**Add a repository** — GitHub → Organization settings → GitHub Apps → Open-Inspect → Install App →
Configure → add the repository under "Only select repositories". It appears in Open-Inspect within a
minute (installation repositories are listed live). Remove it the same way.

**Add / remove an engineer** — membership of the allowlisted GitHub org is the gate. Add them to the
org (or remove them); revoking an active browser session is done from Settings → Users (suspend). To
allow a user outside the org, add their login to Doppler `ALLOWED_USERS` and re-run `apply`.

**Rotate the model key** — Bedrock: IAM → API keys for Bedrock → Generate a new long-term key for
the same user, `doppler secrets set AWS_BEARER_TOKEN_BEDROCK` (value from stdin), run
`deploy/doppler/deploy.sh apply`, then delete the old key in IAM. Anthropic API: same flow with a
new key from the Anthropic console and `doppler secrets set ANTHROPIC_API_KEY`. New sandboxes pick
it up immediately; running ones keep the old key until they exit. Rotate `GITHUB_APP_PRIVATE_KEY`,
`MODAL_API_SECRET`, `GITHUB_CLIENT_SECRET`, `NEXTAUTH_SECRET` the same way (`NEXTAUTH_SECRET` signs
everyone out). Never rotate `PROVIDER_ACCOUNTS_ENCRYPTION_KEY`, `TOKEN_ENCRYPTION_KEY` or
`REPO_SECRETS_ENCRYPTION_KEY` without re-entering the data they protect.

**Inspect usage / cost** — per-session cost is shown in the session header and Settings → Usage; AWS
Cost Explorer filtered to service _Amazon Bedrock_ (or Bedrock → Model invocation logging when
enabled) is authoritative for tokens; Modal dashboard → Usage for sandbox compute; Cloudflare →
Workers & Pages → the two Workers for requests/DO time.

**Cap concurrency** — Settings → Sandbox (child-session counts and spend limit take effect for new
sessions immediately); AWS Budgets on Bedrock (alert + optional IAM deny action); Modal workspace
limits.

**Shut down** — `deploy/doppler/deploy.sh destroy` removes every Cloudflare resource (Workers, DOs,
D1, KV, Queues, custom domain) and the Modal app/secrets; the media bucket is not Terraform's and
survives. Then delete `open-inspect-media` and the R2 state bucket, the Cloudflare/Modal tokens, the
Bedrock API key (IAM), and uninstall the GitHub App. Pausing instead: Modal → Apps → open-inspect →
Stop, and suspend users in Settings → Users.

## Costs

Fixed: Cloudflare Workers Paid $5/mo (required for Durable Objects, D1 and Queues) · R2 ≈ $0 · Modal
$0 base plan · Doppler free/Developer tier · Bedrock $0 base (on-demand) → **≈ $5–30 / month**.

Variable: Bedrock Claude tokens (dominant; same list price as the Anthropic API, billed to AWS) ·
Modal sandbox CPU/memory-seconds (≈ $0.05–0.15 per sandbox-hour at 2 vCPU / 4 GiB, plus image
builds) · Cloudflare request / DO duration above the included quota.

### Inject sandbox secrets from Doppler at launch

The control plane can fetch resolved secrets from a dedicated Doppler config and pass their values
through the existing sandbox environment injection path. The sandbox never needs a Doppler token.
This is a runtime-only source: values are not written to D1 or supplied to image builds. Each
resolution fetches current values; a failed fetch fails the launch rather than falling back to stale
credentials. Existing running sandboxes retain their launch environment.

For Kaizen, create a read-only service token scoped to `kaizen-code-sandbox/prd` and store it as
`SANDBOX_DOPPLER_TOKEN` in the **deployment** project `kaizen-code/prd`. The deployment wrapper maps
it to Terraform's `sandbox_doppler_token` secret, bound only to the control-plane Worker. Do not put
this token in global, repo, environment, or image-build secrets.

Set `sandbox_doppler_repositories = ["kaizen-automation/kaizen"]` in the deployment tfvars.
Environment-launched sessions require a separate explicit `sandbox_doppler_environment_ids`
allowlist; membership of an allowed repository does not implicitly authorize an environment. Empty
allowlists disable fetching. Terraform rejects enabled targets without a nonblank token; runtime
launches also fail closed if the token is missing.

The dedicated Doppler config defines the complete runtime secret set: there is no per-secret
allowlist. Every resolved entry is injected except Doppler credentials and metadata. Only place
credentials intended for these coding sessions in that config.

Doppler values override stored global/repo/environment secrets for authorized targets. Legacy
`DOPPLER_*` and `SANDBOX_DOPPLER_*` keys are removed from their merged runtime environment,
including Doppler metadata. The existing aggregate secret-size limit still applies. The fetch uses a
fixed HTTPS endpoint, rejects redirects, bounds response size, and has a ten-second timeout; errors
never include response bodies or credential values.

Before cutover, remove old Doppler tokens from Inspect's secret stores and rebuild any images that
previously persisted those tokens. Setup/start hooks must consume the already-injected environment
instead of running `doppler run` or downloading configuration. For the Kaizen monorepo, set
`KZ_USE_DOPPLER=0` in `kaizen-code-sandbox/prd`: its `scripts/run-with-doppler.sh` wrapper then
executes commands directly with the injected environment, even if an image still has local Doppler
configuration. This does not override a custom hook that explicitly calls `doppler run`; inspect the
live repository/environment hooks and remove those calls before cutover. Image builds should receive
only separately scoped build credentials (such as registry access), not this runtime config
containing database credentials. Keep production replica access under its separate key; it does not
replace the local development `DB_*` settings.

Deploy the control-plane change before enabling the allowlist and token. Verify an authorized new
session receives expected keys, has no Doppler token, and can start the development app without
Doppler. Verify unrelated repositories and unapproved environments receive no runtime Doppler
secrets. Local tests use synthetic credentials; live launch verification is still required.
