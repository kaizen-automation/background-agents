# A Bedrock API key switches the Claude harness in Modal sandboxes to Amazon
# Bedrock. The switch, the key and the region travel together in the
# deployment-wide LLM secret, and are all reconciled back to empty when the key
# is removed.

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
  deployment_name             = "bedrock-test"

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

  anthropic_api_key = ""
}

run "a_bedrock_key_switches_sandboxes_to_bedrock" {
  command = plan

  variables {
    aws_bearer_token_bedrock = " test-bedrock-key "
    aws_region               = "us-west-2"
  }

  assert {
    condition = local.modal_llm_secret_values == {
      ANTHROPIC_API_KEY        = ""
      CLAUDE_CODE_USE_BEDROCK  = "1"
      AWS_BEARER_TOKEN_BEDROCK = "test-bedrock-key"
      AWS_REGION               = "us-west-2"
    }
    error_message = "A configured Bedrock key must inject the switch, the trimmed key and the region."
  }

  # The control plane worker never sees the Bedrock key: only sandboxes call the model.
  assert {
    condition     = !contains(module.control_plane_worker.secret_binding_names, "AWS_BEARER_TOKEN_BEDROCK")
    error_message = "The Bedrock key must not be bound on the control plane worker."
  }
}

# A region without a key is inert rather than leaking into sandboxes, where an
# unrelated AWS_REGION would steer the agent's own AWS tooling.
run "a_region_without_a_key_stays_out_of_sandboxes" {
  command = plan

  variables {
    aws_region = "us-west-2"
  }

  assert {
    condition     = local.modal_llm_secret_values == { ANTHROPIC_API_KEY = "", CLAUDE_CODE_USE_BEDROCK = "", AWS_BEARER_TOKEN_BEDROCK = "", AWS_REGION = "" }
    error_message = "A region alone must not enable Bedrock or reach sandboxes."
  }
}

run "a_bedrock_key_without_a_region_is_rejected" {
  command = plan

  variables {
    aws_bearer_token_bedrock = "test-bedrock-key"
  }

  expect_failures = [var.aws_region]
}
