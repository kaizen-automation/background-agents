# Configure an externally managed Access application before enabling the browser route.
variable "browser_ingress_enabled" {
  description = "Configure JWT verification for the browser route using an existing Access application."
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
variable "browser_access_audience" {
  description = "AUD of the externally managed Access application protecting the control plane /browser/* path."
  type        = string
  default     = ""
  validation {
    condition     = !var.browser_ingress_enabled || can(regex("^[0-9a-fA-F]{64}$", var.browser_access_audience))
    error_message = "Browser ingress requires the existing Access application AUD (64 hexadecimal characters)."
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

# Access policy administration stays outside the deployment token's authority.
locals {
  browser_access_bindings = var.browser_ingress_enabled ? {
    ACCESS_ISSUER                  = { value = var.access_team_domain }
    ACCESS_AUDIENCE                = { value = var.browser_access_audience }
    ACCESS_SERVICE_TOKEN_CLIENT_ID = { value = var.gateway_access_client_id }
  } : {}
}

variable "browser_web_origin" {
  description = "Optional browser-visible HTTPS origin for user authentication behind a gateway. Does not change the Worker custom domain."
  type        = string
  default     = ""
  validation {
    condition     = var.browser_web_origin == "" || can(regex("^https://[a-zA-Z0-9.-]+(:[0-9]+)?$", var.browser_web_origin))
    error_message = "browser_web_origin must be an HTTPS origin without a path, query, fragment, or trailing slash."
  }
}
