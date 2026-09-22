# Tailnet ingress proxy: a Tailscale node that is the only way into a
# tailnet-only Open-Inspect deployment. `tailscale serve` terminates TLS on the
# node's MagicDNS hostname and hands requests to Caddy, which routes them to
# the web and control-plane Workers with the shared proxy token attached.
FROM tailscale/tailscale:v1.102.4 AS tailscale

FROM caddy:2.10-alpine

COPY --from=tailscale /usr/local/bin/tailscaled /usr/local/bin/tailscaled
COPY --from=tailscale /usr/local/bin/tailscale /usr/local/bin/tailscale

RUN apk add --no-cache ca-certificates iptables ip6tables \
  && mkdir -p /var/run/tailscale /var/lib/tailscale

COPY Caddyfile /etc/caddy/Caddyfile
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENV TS_STATE_DIR=/var/lib/tailscale \
    CADDY_LISTEN_PORT=8080 \
    CONTROL_PLANE_PATH_PREFIX=/_control-plane

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
