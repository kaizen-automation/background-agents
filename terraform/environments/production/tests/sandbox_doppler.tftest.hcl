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



run "repository_requires_token" {
  command = plan
  variables { sandbox_doppler_repositories = ["kaizen-automation/kaizen"] }
  expect_failures = [var.sandbox_doppler_token]
}
run "environment_requires_token" {
  command = plan
  variables { sandbox_doppler_environment_ids = ["env-approved"] }
  expect_failures = [var.sandbox_doppler_token]
}
run "whitespace_token_rejected" {
  command = plan
  variables {
    sandbox_doppler_repositories = ["kaizen-automation/kaizen"]
    sandbox_doppler_token = "   "
  }
  expect_failures = [var.sandbox_doppler_token]
}
run "configured_repository" {
  command = plan
  variables {
    sandbox_doppler_repositories = ["kaizen-automation/kaizen"]
    sandbox_doppler_token = "test-launch-token"
  }
  assert {
    condition = module.control_plane_worker.plain_text_bindings["SANDBOX_DOPPLER_REPOSITORIES"] == "kaizen-automation/kaizen"
    error_message = "Authorized repositories must reach the control plane."
  }
}
