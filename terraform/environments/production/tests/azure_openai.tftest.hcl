# Azure OpenAI (Azure AI Foundry) credentials let the OpenCode harness run
# azure/* catalog models through the company's Azure resource. The key and the
# resource name travel together in the deployment-wide LLM secret, are both
# reconciled back to empty when removed, and are rejected when only one is set.

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
  deployment_name             = "azure-test"

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

run "azure_credentials_are_injected_into_sandboxes" {
  command = plan

  variables {
    azure_openai_api_key       = " test-azure-key "
    azure_openai_resource_name = " contoso-foundry "
  }

  assert {
    condition = local.modal_llm_secret_values == {
      ANTHROPIC_API_KEY        = ""
      CLAUDE_CODE_USE_BEDROCK  = ""
      AWS_BEARER_TOKEN_BEDROCK = ""
      AWS_REGION               = ""
      AZURE_API_KEY            = "test-azure-key"
      AZURE_RESOURCE_NAME      = "contoso-foundry"
    }
    error_message = "Configured Azure credentials must inject the trimmed key and resource name as AZURE_API_KEY / AZURE_RESOURCE_NAME."
  }

  # The Claude harness's Bedrock switch is independent of Azure.
  assert {
    condition     = !local.bedrock_enabled
    error_message = "Azure credentials must not switch the Claude harness to Bedrock."
  }

  # The control plane worker never sees the Azure key: only sandboxes call the model.
  assert {
    condition     = !contains(module.control_plane_worker.secret_binding_names, "AZURE_API_KEY")
    error_message = "The Azure key must not be bound on the control plane worker."
  }
}

# Unset credentials stay present as empty values so --force reconciles a
# previously configured Azure credential away instead of leaving it behind.
run "unset_azure_credentials_are_empty_values" {
  command = plan

  assert {
    condition     = local.modal_llm_secret_values.AZURE_API_KEY == "" && local.modal_llm_secret_values.AZURE_RESOURCE_NAME == ""
    error_message = "Unset Azure credentials must be injected as empty values, not omitted."
  }
}

run "an_azure_key_without_a_resource_name_is_rejected" {
  command = plan

  variables {
    azure_openai_api_key = "test-azure-key"
  }

  expect_failures = [var.azure_openai_resource_name]
}

run "an_azure_resource_name_without_a_key_is_rejected" {
  command = plan

  variables {
    azure_openai_resource_name = "contoso-foundry"
  }

  expect_failures = [var.azure_openai_resource_name]
}
