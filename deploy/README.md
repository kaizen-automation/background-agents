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
                                           │  SDK + repo checkout  │──────▶ Anthropic API
                                           └──────────────────────┘
Doppler open-inspect/prd ──(deploy time only)──▶ TF_VAR_* ──▶ Worker secrets · Modal secrets
```

## Secrets

Doppler project `open-inspect`, config `prd`, is the only place secrets live. The wrapper
`deploy/doppler/deploy.sh` runs `doppler run --no-fallback` and maps each Doppler secret to the
`TF_VAR_*` (or backend) environment variable that upstream Terraform already consumes. No tfvars
file, fallback cache, or command-line argument ever carries a secret value.

| Doppler secret                                                                     | Consumer                                    | Runtime variable / use                            |
| ---------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------- |
| `CLOUDFLARE_ACCOUNT_ID`                                                            | Terraform provider, wrangler                | account for all Cloudflare resources              |
| `CLOUDFLARE_API_TOKEN`                                                             | Terraform provider, wrangler                | scoped token (see below)                          |
| `CLOUDFLARE_ZONE_ID`                                                               | Terraform                                   | zone `kaizenautomation.dev`                       |
| `CLOUDFLARE_WORKER_SUBDOMAIN`                                                      | Terraform                                   | `kaizen-agents` → control-plane `*.workers.dev`   |
| `CLOUDFLARE_CUSTOM_DOMAIN`                                                         | Terraform                                   | `agents.kaizenautomation.dev` (web Worker)        |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`                                         | Terraform S3 backend                        | state in R2 bucket `open-inspect-terraform-state` |
| `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET`                                             | Terraform → `modal` CLI                     | deploy Modal app + secrets                        |
| `MODAL_WORKSPACE` (+ optional `MODAL_ENVIRONMENT`, `MODAL_ENVIRONMENT_WEB_SUFFIX`) | Terraform                                   | Modal endpoint URLs                               |
| `ANTHROPIC_API_KEY`                                                                | Modal secret `llm-api-keys`                 | sandbox `ANTHROPIC_API_KEY` (Claude harness)      |
| `GITHUB_APP_ID`                                                                    | Worker secret + Modal secret `github-app`   | `GITHUB_APP_ID`                                   |
| `GITHUB_APP_PRIVATE_KEY` (PKCS#8)                                                  | Worker secret + Modal secret `github-app`   | `GITHUB_APP_PRIVATE_KEY`                          |
| `GITHUB_APP_INSTALLATION_ID`                                                       | Worker secret + Modal secret `github-app`   | `GITHUB_APP_INSTALLATION_ID`                      |
| `GITHUB_CLIENT_ID`                                                                 | Worker var                                  | GitHub sign-in                                    |
| `GITHUB_CLIENT_SECRET`                                                             | Worker secret                               | `GITHUB_CLIENT_SECRET`                            |
| `ALLOWED_GITHUB_ORGS`                                                              | Worker var                                  | admission: active members of these orgs           |
| `NEXTAUTH_SECRET`                                                                  | Worker secret                               | `BROWSER_AUTH_SECRET` (session cookies)           |
| `TOKEN_ENCRYPTION_KEY`                                                             | Worker secret                               | encrypts per-user GitHub tokens                   |
| `REPO_SECRETS_ENCRYPTION_KEY`                                                      | Worker secret                               | encrypts Settings → Secrets in D1                 |
| `PROVIDER_ACCOUNTS_ENCRYPTION_KEY`                                                 | Worker secret                               | encrypts provider accounts — never change         |
| `MODAL_API_SECRET`                                                                 | Worker secret + Modal secret `internal-api` | control plane ↔ Modal auth                        |

Generated secrets are 32 random bytes, base64 (`openssl rand -base64 32`), created straight into
Doppler with `doppler secrets set NAME="$(openssl rand -base64 32)" --silent`.

### Cloudflare API token (least privilege)

Account: Workers Scripts Edit · Workers KV Storage Edit · Workers R2 Storage Edit · D1 Edit · Queues
Edit · Account Settings Read. Zone (only `kaizenautomation.dev`): Workers Routes Edit · DNS Edit.
Nothing else. R2 Storage is needed for the media bucket; DNS Edit for the
`cloudflare_workers_custom_domain` record. Verify a token without printing it:
`deploy/doppler/deploy.sh run bash -c 'curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/r2/buckets | jq .success'`.

### GitHub App permissions

Repository: Contents R/W · Pull requests R/W · Metadata Read. Organization: Members Read (org
admission). Installed with **Only select repositories**. Webhook inactive (GitHub bot disabled).

### What reaches a sandbox

Only `ANTHROPIC_API_KEY` (from a dedicated Anthropic workspace with a spend cap), a per-session
sandbox token, and a short-lived GitHub installation token. Production application credentials are
never present unless someone deliberately adds them under Settings → Secrets.

## Deploying

```bash
export DOPPLER_TOKEN=...              # read-only service token for open-inspect/prd
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

After the first deploy, bootstrap the workspace Owner (upstream Step 7a):

```bash
deploy/doppler/deploy.sh run npm run rbac:bootstrap-owner -- --database <d1_database_name> --user <user-id> --execute
```

## Limits

| Limit                              | Where                                                 | Value                   |
| ---------------------------------- | ----------------------------------------------------- | ----------------------- |
| Concurrent child sessions per task | Settings → Sandbox → `maxConcurrentChildSessions`     | 4                       |
| Total child sessions per task      | Settings → Sandbox → `maxTotalChildSessions`          | 8                       |
| Child nesting depth                | hard-coded upstream (`MAX_SPAWN_DEPTH`)               | 2                       |
| Per-session spend                  | Settings → Sandbox → `maxSessionCostUsd`              | 15                      |
| Sandbox size / lifetime            | Settings → Sandbox                                    | 2 vCPU · 4096 MiB · 2 h |
| Total Anthropic spend              | Anthropic Console → workspace `open-inspect` → limits | monthly cap             |
| Total sandboxes                    | Modal workspace resource limits                       | see Modal settings      |

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

**Rotate the Anthropic key** — create a new key in the `open-inspect` workspace,
`doppler secrets set ANTHROPIC_API_KEY`, run `deploy/doppler/deploy.sh apply`, then delete the old
key in the Console. New sandboxes pick it up immediately; running ones keep the old key until they
exit. Rotate `GITHUB_APP_PRIVATE_KEY`, `MODAL_API_SECRET`, `GITHUB_CLIENT_SECRET`, `NEXTAUTH_SECRET`
the same way (`NEXTAUTH_SECRET` signs everyone out). Never rotate
`PROVIDER_ACCOUNTS_ENCRYPTION_KEY`, `TOKEN_ENCRYPTION_KEY` or `REPO_SECRETS_ENCRYPTION_KEY` without
re-entering the data they protect.

**Inspect usage / cost** — per-session cost is shown in the session header and Settings → Usage;
Anthropic Console → Usage (workspace `open-inspect`) is authoritative for tokens; Modal dashboard →
Usage for sandbox compute; Cloudflare → Workers & Pages → the two Workers for requests/DO time.

**Cap concurrency** — Settings → Sandbox (child-session counts and spend limit take effect for new
sessions immediately); Anthropic workspace spend limit; Modal workspace limits.

**Shut down** — `deploy/doppler/deploy.sh destroy` removes every Cloudflare resource (Workers, DOs,
D1, KV, R2 media bucket, Queues, custom domain) and the Modal app/secrets. Then delete the R2 state
bucket, the Cloudflare/Modal tokens, the Anthropic workspace key, and uninstall the GitHub App.
Pausing instead: Modal → Apps → open-inspect → Stop, and suspend users in Settings → Users.

## Costs

Fixed: Cloudflare Workers Paid $5/mo (required for Durable Objects, D1 and Queues) · R2 ≈ $0 · Modal
$0 base plan · Doppler free/Developer tier · Anthropic $0 base → **≈ $5–30 / month**.

Variable: Anthropic tokens (dominant; cap in the Console) · Modal sandbox CPU/memory-seconds (≈
$0.05–0.15 per sandbox-hour at 2 vCPU / 4 GiB, plus image builds) · Cloudflare request / DO duration
above the included quota.
