# An R2 media bucket provisioned out-of-band is bound, never managed: the
# Cloudflare deployment token then needs no R2 permission at all.

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
  deployment_name             = "r2-test"

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

run "an_external_bucket_is_bound_but_not_managed" {
  command = plan

  variables {
    r2_media_bucket_managed = false
    r2_media_bucket_name    = "open-inspect-media"
  }

  assert {
    condition     = length(cloudflare_r2_bucket.media) == 0
    error_message = "Terraform must not declare the media bucket when it is provisioned out-of-band."
  }

  assert {
    condition     = module.control_plane_worker.r2_bucket_bindings == { MEDIA_BUCKET = "open-inspect-media" }
    error_message = "The control plane must bind MEDIA_BUCKET to the pre-created bucket by name."
  }
}

run "an_external_bucket_must_be_named" {
  command = plan

  variables {
    r2_media_bucket_managed = false
    r2_media_bucket_name    = ""
  }

  expect_failures = [var.r2_media_bucket_name]
}

run "a_managed_bucket_keeps_the_upstream_default" {
  command = plan

  assert {
    condition     = length(cloudflare_r2_bucket.media) == 1 && cloudflare_r2_bucket.media[0].name == "open-inspect-media-r2-test"
    error_message = "Without opting out, Terraform manages the media bucket under the upstream default name."
  }

  assert {
    condition     = module.control_plane_worker.r2_bucket_bindings == { MEDIA_BUCKET = "open-inspect-media-r2-test" }
    error_message = "The managed bucket must be the one bound to the control plane."
  }
}
