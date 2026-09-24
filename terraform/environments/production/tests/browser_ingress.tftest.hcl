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
    condition     = alltrue([for name in ["ACCESS_ISSUER", "ACCESS_AUDIENCE", "ACCESS_SERVICE_TOKEN_CLIENT_ID"] : !contains(keys(module.control_plane_worker.plain_text_bindings), name)]) && module.control_plane_worker.plain_text_bindings["REQUIRE_BROWSER_GATEWAY"] == "false"
    error_message = "Existing deployments must not be cut over implicitly."
  }
}
run "configure_existing_app_before_cutover" {
  command = plan
  variables {
    browser_ingress_enabled  = true
    access_team_domain       = "https://test.cloudflareaccess.com"
    browser_access_audience  = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    gateway_access_client_id = "test.access"
  }
  assert {
    condition     = module.control_plane_worker.plain_text_bindings["REQUIRE_BROWSER_GATEWAY"] == "false"
    error_message = "Configuring verification must not close the old browser path."
  }
  assert {
    condition     = module.control_plane_worker.plain_text_bindings["ACCESS_AUDIENCE"] == var.browser_access_audience
    error_message = "The existing application AUD must reach the Worker."
  }
  assert {
    condition     = module.control_plane_worker.plain_text_bindings["ACCESS_ISSUER"] == var.access_team_domain && module.control_plane_worker.plain_text_bindings["ACCESS_SERVICE_TOKEN_CLIENT_ID"] == var.gateway_access_client_id
    error_message = "The existing issuer and gateway identity must reach the Worker."
  }
}
run "private_transport_without_changing_oauth" {
  command = plan
  variables {
    browser_ingress_enabled  = true
    require_browser_gateway  = true
    access_team_domain       = "https://test.cloudflareaccess.com"
    browser_access_audience  = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    gateway_access_client_id = "test.access"
    browser_websocket_url    = "wss://inspect-gateway.example.ts.net/_control-plane"
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
  expect_failures = [var.access_team_domain, var.browser_access_audience, var.gateway_access_client_id]
}

run "reject_malformed_audience" {
  command = plan
  variables {
    browser_ingress_enabled  = true
    access_team_domain       = "https://test.cloudflareaccess.com"
    browser_access_audience  = "not-an-application-audience"
    gateway_access_client_id = "test.access"
  }
  expect_failures = [var.browser_access_audience]
}
