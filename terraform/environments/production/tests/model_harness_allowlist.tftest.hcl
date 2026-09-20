# The deployment's model and harness allowlists reach the control plane as
# comma-joined plain-text bindings; empty lists become empty strings, which the
# control plane reads as "the whole shared catalog".

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
  github_app_id               = "1"
  github_app_private_key      = "test-private-key"
  github_app_installation_id  = "1"
  token_encryption_key        = "test-token-key"
  repo_secrets_encryption_key = "test-repo-key"
  nextauth_secret             = "test-browser-auth-secret-with-32-characters"
  deployment_name             = "allowlist-test"

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

run "allowlists_reach_the_control_plane_comma_joined" {
  command = plan

  variables {
    model_allowlist   = ["anthropic/claude-sonnet-4-6", "anthropic/claude-opus-4-7"]
    harness_allowlist = ["opencode"]
  }

  assert {
    condition     = module.control_plane_worker.plain_text_bindings["MODEL_ALLOWLIST"] == "anthropic/claude-sonnet-4-6,anthropic/claude-opus-4-7"
    error_message = "MODEL_ALLOWLIST must carry the configured model ids, comma-joined."
  }

  assert {
    condition     = module.control_plane_worker.plain_text_bindings["HARNESS_ALLOWLIST"] == "opencode"
    error_message = "HARNESS_ALLOWLIST must carry the configured harness ids, comma-joined."
  }
}

run "empty_allowlists_leave_the_catalog_unrestricted" {
  command = plan

  assert {
    condition     = module.control_plane_worker.plain_text_bindings["MODEL_ALLOWLIST"] == ""
    error_message = "An unset model allowlist must bind an empty string."
  }

  assert {
    condition     = module.control_plane_worker.plain_text_bindings["HARNESS_ALLOWLIST"] == ""
    error_message = "An unset harness allowlist must bind an empty string."
  }
}

run "an_unknown_harness_is_rejected" {
  command = plan

  variables {
    harness_allowlist = ["codex"]
  }

  expect_failures = [var.harness_allowlist]
}
