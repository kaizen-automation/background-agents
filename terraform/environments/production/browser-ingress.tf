# Provision first, deploy the Render gateway path rewrite, then require the gateway.
variable "browser_ingress_enabled" {
  description = "Provision the Access-protected browser WebSocket route."
  type        = bool
  default     = false
}
variable "require_browser_gateway" {
  description = "Reject browser WebSockets on the public control-plane entrypoint."
  type        = bool
  default     = false
  validation {
    condition     = !var.require_browser_gateway || (var.browser_ingress_enabled && var.browser_websocket_url != "")
    error_message = "Requiring the gateway needs browser_ingress_enabled and browser_websocket_url."
  }
}
variable "browser_websocket_url" {
  description = "Browser-visible wss base URL, including the gateway /_control-plane prefix. Independent of OAuth/public web URL."
  type        = string
  default     = ""
  validation {
    condition     = var.browser_websocket_url == "" || can(regex("^wss://[^/?#]+(/[^?#]*)?[^/]$", var.browser_websocket_url))
    error_message = "Use a wss URL without query, fragment, or trailing slash."
  }
}
variable "access_team_domain" {
  description = "Access JWT issuer: https://TEAM.cloudflareaccess.com (no trailing slash)."
  type        = string
  default     = ""
  validation {
    condition     = !var.browser_ingress_enabled || can(regex("^https://[a-z0-9-]+\\.cloudflareaccess\\.com$", var.access_team_domain))
    error_message = "Browser ingress requires the Cloudflare Access team domain."
  }
}
variable "gateway_access_service_token_id" {
  description = "UUID of the existing gateway Access service token; not its secret or client ID."
  type        = string
  default     = ""
  validation {
    condition     = !var.browser_ingress_enabled || can(regex("^[0-9a-fA-F-]{36}$", var.gateway_access_service_token_id))
    error_message = "Browser ingress requires an existing Access service-token UUID."
  }
}
variable "gateway_access_client_id" {
  description = "Client ID of that same token, checked against the signed JWT common_name. Not a secret."
  type        = string
  default     = ""
  validation {
    condition     = !var.browser_ingress_enabled || (trimspace(var.gateway_access_client_id) != "" && !strcontains(var.gateway_access_client_id, ":"))
    error_message = "Browser ingress requires the bare gateway Access client ID."
  }
}

resource "cloudflare_zero_trust_access_policy" "browser_gateway" {
  count      = var.browser_ingress_enabled ? 1 : 0
  account_id = var.cloudflare_account_id
  name       = "${var.app_name} tailnet gateway WebSockets"
  decision   = "non_identity"
  include    = [{ service_token = { token_id = var.gateway_access_service_token_id } }]
}

# Hostname-based Access: Worker-level Access does not support WebSocket upgrades.
resource "cloudflare_zero_trust_access_application" "browser_ingress" {
  count                = var.browser_ingress_enabled ? 1 : 0
  account_id           = var.cloudflare_account_id
  name                 = "${var.deployment_name}-code-control-plane"
  type                 = "self_hosted"
  domain               = "${local.control_plane_host}/browser/*"
  app_launcher_visible = false
  policies             = [{ id = cloudflare_zero_trust_access_policy.browser_gateway[0].id, precedence = 1 }]
}
