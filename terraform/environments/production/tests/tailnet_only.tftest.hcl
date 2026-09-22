# Tailnet-only ingress: browser URLs move to the Tailscale hostname and both
# Workers receive the proxy token; the public control-plane URL is untouched.

mock_provider "cloudflare" {}
mock_provider "external" {
  mock_data "external" {
    defaults = {
      result = {
        hash = "test-source-hash"
      }
    }
  }
}
mock_provider "local" {}
mock_provider "null" {}
mock_provider "random" {}
mock_provider "vercel" {}

variables {
  cloudflare_api_token        = "test-cloudflare-token"
  cloudflare_account_id       = "test-account"
  cloudflare_worker_subdomain = "test-account"
  cloudflare_zone_id          = "test-zone"
  cloudflare_custom_domain    = "agents.example.com"
  github_app_id               = "1"
  github_app_private_key      = "test-private-key"
  github_app_installation_id  = "1"
  token_encryption_key        = "test-token-key"
  repo_secrets_encryption_key = "test-repo-key"
  nextauth_secret             = "test-browser-auth-secret-with-32-characters"
  deployment_name             = "tailnet-test"

  modal_token_id     = "test-modal-token-id"
  modal_token_secret = "test-modal-token-secret"
  modal_workspace    = "test-workspace"
  modal_api_secret   = "test-modal-api-secret"

  web_platform      = "cloudflare"
  project_root      = "../../../"
  enable_github_bot = false
  enable_slack_bot  = false
  enable_linear_bot = false

  github_client_id     = "github-id"
  github_client_secret = "github-secret"
  allowed_users        = "octocat"

  anthropic_api_key = "test-anthropic-key"
}

run "public_deployment_keeps_public_urls" {
  command = plan

  assert {
    condition     = local.web_app_url == "https://agents.example.com"
    error_message = "Without tailnet inputs the web app URL is the custom domain."
  }

  assert {
    condition     = local.ws_url == "wss://open-inspect-control-plane-tailnet-test.test-account.workers.dev"
    error_message = "Without tailnet inputs browsers open WebSockets to the public control plane."
  }

  assert {
    condition     = !contains(module.control_plane_worker.secret_binding_names, "TAILNET_PROXY_TOKEN")
    error_message = "The control plane must not receive a tailnet token when the gate is off."
  }
}

run "tailnet_only_moves_browser_urls_and_binds_the_token" {
  command = plan

  variables {
    tailnet_hostname    = "agents.tail1234.ts.net"
    tailnet_proxy_token = "0123456789abcdef0123456789abcdef"
  }

  assert {
    condition     = local.web_app_url == "https://agents.tail1234.ts.net"
    error_message = "The web app URL must be the tailnet hostname."
  }

  assert {
    condition     = local.ws_url == "wss://agents.tail1234.ts.net/_control-plane"
    error_message = "Browser WebSockets must go through the proxy's control-plane path prefix."
  }

  assert {
    condition     = local.control_plane_url == "https://open-inspect-control-plane-tailnet-test.test-account.workers.dev"
    error_message = "Service-to-service traffic keeps the public control-plane URL."
  }

  assert {
    condition     = contains(module.control_plane_worker.secret_binding_names, "TAILNET_PROXY_TOKEN")
    error_message = "The control plane must receive the tailnet token."
  }

  assert {
    condition     = strcontains(local_file.web_app_wrangler_production[0].content, "main = \"worker/index.mjs\"")
    error_message = "The web Worker must be deployed through the tailnet gate entrypoint."
  }
}

run "hostname_without_token_is_rejected" {
  command = plan

  variables {
    tailnet_hostname = "agents.tail1234.ts.net"
  }

  expect_failures = [terraform_data.tailnet_only_gate]
}

run "short_token_is_rejected" {
  command = plan

  variables {
    tailnet_hostname    = "agents.tail1234.ts.net"
    tailnet_proxy_token = "too-short"
  }

  expect_failures = [var.tailnet_proxy_token]
}
