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
  cloudflare_api_token             = "test-cloudflare-token"
  cloudflare_account_id            = "test-account"
  cloudflare_worker_subdomain      = "test-account"
  github_app_id                    = "1"
  github_app_private_key           = "test-private-key"
  github_app_installation_id       = "1"
  anthropic_api_key                = "test-anthropic-key"
  token_encryption_key             = "test-token-key"
  repo_secrets_encryption_key      = "test-repo-key"
  provider_accounts_encryption_key = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="
  nextauth_secret                  = "test-browser-auth-secret-with-32-characters"
  deployment_name                  = "auth-provider-test"

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
}


run "disabled_by_default" {
  command = plan
  assert {
    condition     = length(cloudflare_zero_trust_access_application.browser_ingress) == 0 && !var.require_browser_gateway
    error_message = "Existing deployments must not be cut over implicitly."
  }
}
run "provision_before_cutover" {
  command = plan
  variables {
    browser_ingress_enabled         = true
    access_team_domain              = "https://test.cloudflareaccess.com"
    gateway_access_service_token_id = "00000000-0000-0000-0000-000000000001"
    gateway_access_client_id        = "test.access"
  }
  assert {
    condition     = length(cloudflare_zero_trust_access_application.browser_ingress) == 1 && !var.require_browser_gateway
    error_message = "Provisioning must not close the old browser path."
  }
  assert {
    condition     = cloudflare_zero_trust_access_policy.browser_gateway[0].decision == "non_identity"
    error_message = "Only service-token auth belongs on the browser ingress."
  }
  assert {
    condition     = cloudflare_zero_trust_access_application.browser_ingress[0].domain == "${local.control_plane_host}/browser/*"
    error_message = "Access must protect the browser path on the existing control plane."
  }
}
run "private_transport_without_changing_oauth" {
  command = plan
  variables {
    browser_ingress_enabled         = true
    require_browser_gateway         = true
    access_team_domain              = "https://test.cloudflareaccess.com"
    gateway_access_service_token_id = "00000000-0000-0000-0000-000000000001"
    gateway_access_client_id        = "test.access"
    browser_websocket_url           = "wss://inspect-gateway.example.ts.net/_control-plane"
  }
  assert {
    condition     = local.ws_url == var.browser_websocket_url && local.web_app_url != "https://inspect-gateway.example.ts.net"
    error_message = "Private socket transport must not implicitly change the OAuth origin."
  }
}
run "reject_premature_cutover" {
  command = plan
  variables { require_browser_gateway = true }
  expect_failures = [var.require_browser_gateway]
}
run "reject_incomplete_access_configuration" {
  command = plan
  variables { browser_ingress_enabled = true }
  expect_failures = [var.access_team_domain, var.gateway_access_service_token_id, var.gateway_access_client_id]
}
