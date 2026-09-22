#!/bin/sh
# Join the tailnet, expose Caddy on the node's MagicDNS hostname over HTTPS,
# then run Caddy in the foreground.
#
# Required environment:
#   TS_AUTHKEY            Tailscale auth key (reusable + tagged recommended); only
#                         needed until the node state under TS_STATE_DIR exists
#   TS_HOSTNAME           Machine name; browsers use https://<TS_HOSTNAME>.<tailnet>.ts.net
#   WEB_ORIGIN            e.g. https://agents.example.com (the web Worker)
#   CONTROL_PLANE_ORIGIN  e.g. https://open-inspect-control-plane-<name>.<acct>.workers.dev
#   TAILNET_PROXY_TOKEN   Same value as the Terraform tailnet_proxy_token input
set -eu

: "${TS_HOSTNAME:?TS_HOSTNAME is required}"
: "${WEB_ORIGIN:?WEB_ORIGIN is required}"
: "${CONTROL_PLANE_ORIGIN:?CONTROL_PLANE_ORIGIN is required}"
: "${TAILNET_PROXY_TOKEN:?TAILNET_PROXY_TOKEN is required}"

TS_SOCKET=/var/run/tailscale/tailscaled.sock

tailscaled \
  --tun=userspace-networking \
  --state="${TS_STATE_DIR}/tailscaled.state" \
  --socket="${TS_SOCKET}" \
  --statedir="${TS_STATE_DIR}" &
TAILSCALED_PID=$!

until tailscale --socket="${TS_SOCKET}" status >/dev/null 2>&1 \
  || tailscale --socket="${TS_SOCKET}" status 2>&1 | grep -q "Logged out"; do
  sleep 1
done

if tailscale --socket="${TS_SOCKET}" status 2>&1 | grep -q "Logged out"; then
  : "${TS_AUTHKEY:?TS_AUTHKEY is required for the first start (no saved node state)}"
  tailscale --socket="${TS_SOCKET}" up --authkey="${TS_AUTHKEY}" --hostname="${TS_HOSTNAME}"
else
  tailscale --socket="${TS_SOCKET}" up --hostname="${TS_HOSTNAME}"
fi

# HTTPS on 443 of the MagicDNS name -> Caddy. Requires MagicDNS + HTTPS
# certificates enabled in the tailnet's DNS settings.
tailscale --socket="${TS_SOCKET}" serve --bg --https=443 "http://127.0.0.1:${CADDY_LISTEN_PORT}"

trap 'kill "${TAILSCALED_PID}" 2>/dev/null || true' EXIT INT TERM

exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
