#!/usr/bin/env bash
set -euo pipefail

# Upload current secrets and remove retired web-auth secrets via wrangler.
# Required environment variables:
#   WORKER_NAME          - target worker name
#   SERVICE_AUTH_SECRET  - web's per-service sig1 signing secret
# Optional:
#   TAILNET_PROXY_TOKEN  - tailnet ingress gate token; unset/empty removes the
#                          secret so the Worker is publicly reachable again

echo "Uploading secrets to worker: ${WORKER_NAME}"

echo "${SERVICE_AUTH_SECRET}" | npx wrangler secret put SERVICE_AUTH_SECRET --name "${WORKER_NAME}"

existing_secrets="$(npx wrangler secret list --name "${WORKER_NAME}" --format json)"
has_secret() {
  [[ "${existing_secrets}" =~ \"name\"[[:space:]]*:[[:space:]]*\"$1\" ]]
}

if [[ -n "${TAILNET_PROXY_TOKEN:-}" ]]; then
  echo "${TAILNET_PROXY_TOKEN}" | npx wrangler secret put TAILNET_PROXY_TOKEN --name "${WORKER_NAME}"
elif has_secret TAILNET_PROXY_TOKEN; then
  printf 'y\n' | npx wrangler secret delete TAILNET_PROXY_TOKEN --name "${WORKER_NAME}"
fi

for retired_secret in GITHUB_CLIENT_SECRET GOOGLE_CLIENT_SECRET NEXTAUTH_SECRET; do
  if has_secret "${retired_secret}"; then
    printf 'y\n' | npx wrangler secret delete "${retired_secret}" --name "${WORKER_NAME}"
  fi
done

echo "Secrets uploaded successfully"
