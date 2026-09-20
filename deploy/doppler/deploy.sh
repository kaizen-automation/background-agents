#!/usr/bin/env bash
# Doppler-backed deployment wrapper for the production Terraform environment.
#
# Doppler is the only source of secrets. This script fetches the `prd` config
# once, maps each Doppler secret onto the TF_VAR_* / AWS_* environment variables
# that the existing Terraform environment already reads, and then runs
# Terraform. Nothing is written to disk (no tfvars, no Doppler fallback file),
# nothing secret is passed on a command line, and secret values are never
# echoed.
#
# Usage:
#   deploy/doppler/deploy.sh <command> [terraform args...]
#
# Commands:
#   check            verify tooling and that every required Doppler secret exists (names only)
#   bootstrap        verify the pre-created R2 state bucket via the S3 credentials, then `terraform init`
#   init             `terraform init -reconfigure` against the R2 backend
#   plan  [phase]    `terraform plan`  (phase 1 = bindings off, phase 2 = bindings on; default 2)
#   apply [phase]    `terraform apply`
#   output [args]    `terraform output`
#   destroy          `terraform destroy`
#   tf <args>        arbitrary terraform command with the Doppler environment
#   run <cmd...>     arbitrary command with the mapped environment (e.g. wrangler, modal)
#
# Environment:
#   DOPPLER_TOKEN            service token for the deployment config (read access is enough)
#   DOPPLER_PROJECT          default: open-inspect
#   DOPPLER_CONFIG           default: prd
#   OI_TFVARS_JSON           non-secret inputs; default: deploy/production.tfvars.json
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TF_DIR="${REPO_ROOT}/terraform/environments/production"
STATE_BUCKET="open-inspect-terraform-state"
DOPPLER_PROJECT="${DOPPLER_PROJECT:-open-inspect}"
DOPPLER_CONFIG="${DOPPLER_CONFIG:-prd}"
OI_TFVARS_JSON="${OI_TFVARS_JSON:-${REPO_ROOT}/deploy/production.tfvars.json}"

# Doppler secret -> Terraform variable. Every name on the left must exist in the
# Doppler config (empty string is allowed for OPTIONAL_SECRETS).
REQUIRED_SECRETS=(
  CLOUDFLARE_ACCOUNT_ID
  CLOUDFLARE_API_TOKEN
  CLOUDFLARE_ZONE_ID
  CLOUDFLARE_WORKER_SUBDOMAIN
  CLOUDFLARE_CUSTOM_DOMAIN
  R2_ACCESS_KEY_ID
  R2_SECRET_ACCESS_KEY
  MODAL_TOKEN_ID
  MODAL_TOKEN_SECRET
  MODAL_WORKSPACE
  GITHUB_APP_ID
  GITHUB_APP_PRIVATE_KEY
  GITHUB_APP_INSTALLATION_ID
  GITHUB_CLIENT_ID
  GITHUB_CLIENT_SECRET
  NEXTAUTH_SECRET
  TOKEN_ENCRYPTION_KEY
  REPO_SECRETS_ENCRYPTION_KEY
  PROVIDER_ACCOUNTS_ENCRYPTION_KEY
  MODAL_API_SECRET
  ALLOWED_GITHUB_ORGS
)
OPTIONAL_SECRETS=(
  ANTHROPIC_API_KEY
  AWS_BEARER_TOKEN_BEDROCK
  AWS_REGION
  MODAL_ENVIRONMENT
  MODAL_ENVIRONMENT_WEB_SUFFIX
  GOOGLE_CLIENT_ID
  GOOGLE_CLIENT_SECRET
  ALLOWED_USERS
  ALLOWED_EMAIL_DOMAINS
  ALLOWED_EMAILS
  GITHUB_WEBHOOK_SECRET
  GITHUB_BOT_USERNAME
  SLACK_BOT_TOKEN
  SLACK_SIGNING_SECRET
  LINEAR_CLIENT_ID
  LINEAR_CLIENT_SECRET
  LINEAR_WEBHOOK_SECRET
  LINEAR_API_KEY
  CLASSIFICATION_OPENAI_API_KEY
)
# Secrets consumed by this script / the Terraform backend rather than as TF_VAR_*.
NON_TF_SECRETS=(R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY)
# The Claude harness needs exactly one of these model credentials.
MODEL_CREDENTIAL_SECRETS=(ANTHROPIC_API_KEY AWS_BEARER_TOKEN_BEDROCK)

log() { printf '[deploy] %s\n' "$*" >&2; }
die() { log "error: $*"; exit 1; }

require_tools() {
  local missing=()
  for tool in doppler terraform node npm uv jq curl; do
    command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
  done
  ((${#missing[@]} == 0)) || die "missing tools: ${missing[*]}"
}

doppler_args() {
  printf '%s\n' --project "$DOPPLER_PROJECT" --config "$DOPPLER_CONFIG"
}

# Verify every required secret exists without ever fetching a value.
check_secret_names() {
  local names
  names="$(doppler secrets --only-names --json $(doppler_args) |
    jq -r 'if type == "array" then .[] else keys[] end')" ||
    die "unable to list secret names (is DOPPLER_TOKEN set and scoped to ${DOPPLER_PROJECT}/${DOPPLER_CONFIG}?)"
  local missing=()
  for s in "${REQUIRED_SECRETS[@]}"; do
    grep -qx "$s" <<<"$names" || missing+=("$s")
  done
  ((${#missing[@]} == 0)) || die "missing Doppler secrets in ${DOPPLER_PROJECT}/${DOPPLER_CONFIG}: ${missing[*]}"
  # Empty placeholders: values are inspected by jq in-process and only names are printed.
  local empty
  empty="$(doppler secrets --json $(doppler_args) |
    jq -r --argjson req "$(printf '%s\n' "${REQUIRED_SECRETS[@]}" | jq -R . | jq -s .)" \
      'to_entries | map(select((.key as $k | $req | index($k)) and (.value.computed // "") == "")) | .[].key')"
  [[ -z "$empty" ]] || die "required Doppler secrets are empty in ${DOPPLER_PROJECT}/${DOPPLER_CONFIG}: $(tr '\n' ' ' <<<"$empty")"
  log "all ${#REQUIRED_SECRETS[@]} required secrets present and non-empty in ${DOPPLER_PROJECT}/${DOPPLER_CONFIG}"
  check_model_credential
}

# Exactly one model credential, and Bedrock brings its region along.
check_model_credential() {
  local set_names
  set_names="$(doppler secrets --json $(doppler_args) |
    jq -r --argjson names "$(printf '%s\n' "${MODEL_CREDENTIAL_SECRETS[@]}" AWS_REGION | jq -R . | jq -s .)" \
      'to_entries | map(select((.key as $k | $names | index($k)) and (.value.computed // "" | gsub("\\s"; "") != ""))) | .[].key')"
  local has_anthropic=0 has_bedrock=0 has_region=0
  grep -qx ANTHROPIC_API_KEY <<<"$set_names" && has_anthropic=1
  grep -qx AWS_BEARER_TOKEN_BEDROCK <<<"$set_names" && has_bedrock=1
  grep -qx AWS_REGION <<<"$set_names" && has_region=1
  ((has_anthropic + has_bedrock == 1)) ||
    die "set exactly one model credential in ${DOPPLER_PROJECT}/${DOPPLER_CONFIG}: ${MODEL_CREDENTIAL_SECRETS[*]}"
  if ((has_bedrock)); then
    ((has_region)) || die "AWS_BEARER_TOKEN_BEDROCK is set but AWS_REGION is empty in ${DOPPLER_PROJECT}/${DOPPLER_CONFIG}"
    log "model provider: Amazon Bedrock (Claude Code CLAUDE_CODE_USE_BEDROCK=1)"
  else
    log "model provider: Anthropic API"
  fi
}

# Runs inside `doppler run`: the Doppler secrets are in the environment under
# their Doppler names. Export the Terraform / backend equivalents and exec.
map_env_and_exec() {
  local name lower value
  for name in "${REQUIRED_SECRETS[@]}"; do
    [[ " ${NON_TF_SECRETS[*]} " == *" ${name} "* ]] && continue
    [[ -n "${!name-}" ]] || die "required Doppler secret ${name} is empty"
    lower="$(tr '[:upper:]' '[:lower:]' <<<"$name")"
    export "TF_VAR_${lower}=${!name}"
    unset "$name"
  done
  # Optional inputs keep their Terraform defaults unless set in Doppler.
  for name in "${OPTIONAL_SECRETS[@]}"; do
    value="${!name-}"
    unset "$name"
    [[ -n "$value" ]] || continue
    lower="$(tr '[:upper:]' '[:lower:]' <<<"$name")"
    export "TF_VAR_${lower}=${value}"
  done

  # Terraform S3 backend on Cloudflare R2.
  export AWS_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID}"
  export AWS_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY}"
  export AWS_ENDPOINT_URL_S3="https://${TF_VAR_cloudflare_account_id}.r2.cloudflarestorage.com"
  export AWS_REGION="auto"
  unset R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY

  # Wrangler / Modal CLIs invoked by Terraform local-exec provisioners.
  export CLOUDFLARE_API_TOKEN="${TF_VAR_cloudflare_api_token}"
  export CLOUDFLARE_ACCOUNT_ID="${TF_VAR_cloudflare_account_id}"
  export MODAL_TOKEN_ID="${TF_VAR_modal_token_id}"
  export MODAL_TOKEN_SECRET="${TF_VAR_modal_token_secret}"
  export WRANGLER_SEND_METRICS=false
  export TF_IN_AUTOMATION=1

  exec "$@"
}

with_doppler() {
  [[ -n "${DOPPLER_TOKEN:-}" ]] || die "DOPPLER_TOKEN is not set"
  exec doppler run --no-fallback $(doppler_args) -- \
    "${BASH_SOURCE[0]}" __exec "$@"
}

binding_vars() {
  local phase="${1:-2}"
  case "$phase" in
    1) printf '%s\n' -var enable_durable_object_bindings=false -var enable_service_bindings=false ;;
    2) printf '%s\n' -var enable_durable_object_bindings=true -var enable_service_bindings=true ;;
    *) die "phase must be 1 or 2" ;;
  esac
}

tf() {
  terraform -chdir="$TF_DIR" "$@"
}

# Terraform reads packages/*/dist/index.js at plan time; @open-inspect/shared must build first.
build_workers() {
  log "building shared + worker bundles"
  (cd "$REPO_ROOT" &&
    npm run build -w @open-inspect/shared &&
    npm run build -w @open-inspect/control-plane -w @open-inspect/slack-bot \
      -w @open-inspect/github-bot -w @open-inspect/linear-bot) >/dev/null
}

# The state bucket is provisioned out-of-band and the Cloudflare token holds no
# R2 permission, so it is checked through the bucket-scoped S3 credentials.
cmd_bootstrap() {
  log "checking S3 access to R2 bucket ${STATE_BUCKET}"
  if ! STATE_BUCKET="$STATE_BUCKET" uv run --quiet --with boto3 python - <<'PY'
import os, boto3
boto3.client("s3", endpoint_url=os.environ["AWS_ENDPOINT_URL_S3"], region_name="auto").head_bucket(
    Bucket=os.environ["STATE_BUCKET"]
)
PY
  then
    die "cannot access R2 bucket ${STATE_BUCKET} with R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY"
  fi
  cmd_init
}

cmd_init() {
  tf init -reconfigure -input=false
}

cmd_plan() {
  local phase="${1:-2}"; shift || true
  mapfile -t bvars < <(binding_vars "$phase")
  build_workers
  tf plan -input=false -var-file="$OI_TFVARS_JSON" "${bvars[@]}" "$@"
}

cmd_apply() {
  local phase="${1:-2}"; shift || true
  mapfile -t bvars < <(binding_vars "$phase")
  build_workers
  tf apply -input=false -var-file="$OI_TFVARS_JSON" "${bvars[@]}" "$@"
}

cmd_destroy() {
  mapfile -t bvars < <(binding_vars 2)
  tf destroy -input=false -var-file="$OI_TFVARS_JSON" "${bvars[@]}" "$@"
}

main() {
  local cmd="${1:-}"; shift || true
  case "$cmd" in
    __exec)
      map_env_and_exec "$@" ;;
    check)
      require_tools
      [[ -f "$OI_TFVARS_JSON" ]] || die "missing ${OI_TFVARS_JSON}"
      check_secret_names ;;
    bootstrap) require_tools; with_doppler "${BASH_SOURCE[0]}" __bootstrap ;;
    __bootstrap) cmd_bootstrap ;;
    init)      require_tools; with_doppler "${BASH_SOURCE[0]}" __init ;;
    __init)    cmd_init ;;
    plan)      require_tools; with_doppler "${BASH_SOURCE[0]}" __plan "$@" ;;
    __plan)    cmd_plan "$@" ;;
    apply)     require_tools; with_doppler "${BASH_SOURCE[0]}" __apply "$@" ;;
    __apply)   cmd_apply "$@" ;;
    output)    with_doppler terraform -chdir="$TF_DIR" output "$@" ;;
    destroy)   require_tools; with_doppler "${BASH_SOURCE[0]}" __destroy "$@" ;;
    __destroy) cmd_destroy "$@" ;;
    tf)        with_doppler terraform -chdir="$TF_DIR" "$@" ;;
    run)       with_doppler "$@" ;;
    ""|-h|--help) sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; ;;
    *) die "unknown command: ${cmd}" ;;
  esac
}

main "$@"
