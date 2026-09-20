"""Azure OpenAI (Azure AI Foundry) provider wiring for `opencode serve`.

OpenCode's `azure` provider takes its API key from `AZURE_API_KEY` and its
resource name from `provider.azure.options.resourceName`; the Azure deployment
name must equal the model id, so the model handed to OpenCode is
`azure/<deployment>`.
"""

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from sandbox_runtime.opencode_server import build_azure_provider_config
from tests.runtime_helpers import make_opencode_server

AZURE_ENV = {"AZURE_API_KEY": "azure-key", "AZURE_RESOURCE_NAME": "contoso-foundry"}


def test_helper_pins_resource_name_from_env():
    assert build_azure_provider_config(AZURE_ENV) == {
        "options": {"resourceName": "contoso-foundry"}
    }


@pytest.mark.parametrize("env", [{}, {"AZURE_RESOURCE_NAME": ""}, {"AZURE_RESOURCE_NAME": "  "}])
def test_helper_omits_resource_option_when_unset(env):
    assert build_azure_provider_config(env) == {}


async def start_and_capture_spawn(tmp_path, session_config: dict, extra_env: dict[str, str]):
    server = make_opencode_server(
        {"SESSION_CONFIG": json.dumps(session_config)}, workspace_path=tmp_path
    )
    with (
        patch.dict("os.environ", extra_env, clear=False),
        patch.object(server, "_setup_managed_oauth"),
        patch.object(server, "_prepare_opencode_filesystem", return_value=set()),
        patch.object(server, "_wait_for_health", new_callable=AsyncMock),
        patch(
            "sandbox_runtime.opencode_server.asyncio.create_subprocess_exec",
            new_callable=AsyncMock,
            return_value=MagicMock(stdout=None),
        ) as spawn,
        patch(
            "sandbox_runtime.opencode_server.asyncio.create_task",
            side_effect=lambda coro: coro.close(),
        ),
    ):
        await server.start((), tmp_path)
    env = spawn.call_args.kwargs["env"]
    return json.loads(env["OPENCODE_CONFIG_CONTENT"]), env


async def test_azure_session_emits_provider_block_and_deployment_model(tmp_path):
    config, env = await start_and_capture_spawn(
        tmp_path, {"provider": "azure", "model": "gpt-6-astra"}, AZURE_ENV
    )

    assert config["model"] == "azure/gpt-6-astra"
    assert config["provider"]["azure"] == {"options": {"resourceName": "contoso-foundry"}}
    # Anthropic manual-variant config is unaffected by the Azure block.
    assert set(config["provider"]["anthropic"]["models"]) == {
        "claude-haiku-4-5",
        "claude-sonnet-4-5",
        "claude-opus-4-5",
    }
    # Credentials reach `opencode serve` through its environment.
    assert env["AZURE_API_KEY"] == "azure-key"
    assert env["AZURE_RESOURCE_NAME"] == "contoso-foundry"


async def test_azure_session_without_resource_name_still_targets_azure(tmp_path, monkeypatch):
    monkeypatch.delenv("AZURE_RESOURCE_NAME", raising=False)
    config, _env = await start_and_capture_spawn(
        tmp_path, {"provider": "azure", "model": "gpt-6-astra"}, {}
    )

    assert config["model"] == "azure/gpt-6-astra"
    assert config["provider"]["azure"] == {}


@pytest.mark.parametrize(
    "session_config",
    [
        {},
        {"provider": "openai", "model": "gpt-6-astra"},
        {"provider": "anthropic", "model": "claude-sonnet-4-6"},
    ],
)
async def test_other_providers_never_emit_azure_block(tmp_path, session_config):
    config, _env = await start_and_capture_spawn(tmp_path, session_config, AZURE_ENV)

    assert "azure" not in config["provider"]
    assert not config["model"].startswith("azure/")
