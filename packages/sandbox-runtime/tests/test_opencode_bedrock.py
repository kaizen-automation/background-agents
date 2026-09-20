"""OpenCode sessions run Anthropic models through Amazon Bedrock in Bedrock mode.

The control plane keeps the catalog id (``anthropic/<model>``); only the
provider/model handed to OpenCode changes, and only when the sandbox has
``CLAUDE_CODE_USE_BEDROCK`` switched on with a Bedrock API key present.
"""

import json
import os
from unittest.mock import MagicMock, patch

import pytest

from sandbox_runtime.bridge import AgentBridge
from sandbox_runtime.harness import claude
from sandbox_runtime.harness.bedrock import (
    BEDROCK_MODEL_SNAPSHOTS,
    bedrock_mode_active,
    bedrock_model_id,
    opencode_model_target,
)
from sandbox_runtime.opencode_model_config import build_model_config
from tests.conftest import wire_opencode_transport
from tests.runtime_helpers import make_opencode_server, start_opencode_capturing_env

BEDROCK_ENV = {
    "CLAUDE_CODE_USE_BEDROCK": "1",
    "AWS_BEARER_TOKEN_BEDROCK": "bedrock-api-key",
    "AWS_REGION": "us-west-2",
}
MANUAL_VARIANTS = {
    "variants": {
        "high": {"reasoningConfig": {"type": "enabled", "budgetTokens": 16_000}},
        "max": {"reasoningConfig": {"type": "enabled", "budgetTokens": 31_999}},
    }
}


def session_env(provider: str, model: str, **extra: str) -> dict[str, str]:
    return {"SESSION_CONFIG": json.dumps({"provider": provider, "model": model}), **extra}


class TestBedrockModelId:
    @pytest.mark.parametrize(
        "catalog_model,bedrock_id",
        [
            ("claude-haiku-4-5", "anthropic.claude-haiku-4-5-20251001-v1:0"),
            ("claude-sonnet-4-5", "anthropic.claude-sonnet-4-5-20250929-v1:0"),
            ("claude-opus-4-5", "anthropic.claude-opus-4-5-20251101-v1:0"),
            ("claude-opus-4-6", "anthropic.claude-opus-4-6-v1"),
            ("claude-sonnet-4-6", "anthropic.claude-sonnet-4-6"),
            ("claude-opus-4-7", "anthropic.claude-opus-4-7"),
            ("claude-sonnet-5", "anthropic.claude-sonnet-5"),
            ("claude-opus-5", "anthropic.claude-opus-5"),
        ],
    )
    def test_maps_catalog_model_to_models_dev_bedrock_id(self, catalog_model, bedrock_id):
        assert bedrock_model_id(catalog_model) == bedrock_id

    def test_snapshot_table_is_shared_with_claude_harness(self):
        assert claude.BEDROCK_MODEL_SNAPSHOTS is BEDROCK_MODEL_SNAPSHOTS

    def test_snapshot_models_are_the_manual_thinking_budget_models(self):
        assert set(BEDROCK_MODEL_SNAPSHOTS) == claude.THINKING_BUDGET_MODELS


class TestBedrockModeSwitch:
    def test_requires_switch_and_token(self):
        assert bedrock_mode_active(BEDROCK_ENV)
        assert bedrock_mode_active({**BEDROCK_ENV, "CLAUDE_CODE_USE_BEDROCK": "true"})
        assert not bedrock_mode_active({**BEDROCK_ENV, "CLAUDE_CODE_USE_BEDROCK": "0"})
        assert not bedrock_mode_active({**BEDROCK_ENV, "AWS_BEARER_TOKEN_BEDROCK": ""})
        assert not bedrock_mode_active({})

    def test_only_anthropic_moves_to_bedrock(self):
        assert opencode_model_target("anthropic", "claude-sonnet-4-6", BEDROCK_ENV) == (
            "amazon-bedrock",
            "anthropic.claude-sonnet-4-6",
        )
        assert opencode_model_target("anthropic", "claude-sonnet-4-6", {}) == (
            "anthropic",
            "claude-sonnet-4-6",
        )
        assert opencode_model_target("openai", "gpt-5.6-sol", BEDROCK_ENV) == (
            "openai",
            "gpt-5.6-sol",
        )


class TestBuildModelConfig:
    def test_bedrock_mode_routes_anthropic_through_amazon_bedrock(self):
        config = build_model_config("anthropic", "claude-sonnet-4-6", BEDROCK_ENV)

        assert config == {
            "model": "amazon-bedrock/anthropic.claude-sonnet-4-6",
            "small_model": "amazon-bedrock/anthropic.claude-haiku-4-5-20251001-v1:0",
            "provider": {
                "amazon-bedrock": {
                    "options": {"region": "us-west-2"},
                    "models": {
                        "anthropic.claude-sonnet-4-6": {},
                        "anthropic.claude-haiku-4-5-20251001-v1:0": MANUAL_VARIANTS,
                        "anthropic.claude-opus-4-5-20251101-v1:0": MANUAL_VARIANTS,
                        "anthropic.claude-sonnet-4-5-20250929-v1:0": MANUAL_VARIANTS,
                    },
                }
            },
        }

    def test_bedrock_session_model_with_manual_variants_keeps_them(self):
        config = build_model_config("anthropic", "claude-opus-4-5", BEDROCK_ENV)

        assert config["model"] == "amazon-bedrock/anthropic.claude-opus-4-5-20251101-v1:0"
        models = config["provider"]["amazon-bedrock"]["models"]
        assert models["anthropic.claude-opus-4-5-20251101-v1:0"] == MANUAL_VARIANTS
        assert len(models) == 3

    def test_bedrock_mode_without_region_leaves_region_to_opencode(self):
        env = {name: value for name, value in BEDROCK_ENV.items() if name != "AWS_REGION"}
        config = build_model_config("anthropic", "claude-sonnet-4-6", env)

        assert "options" not in config["provider"]["amazon-bedrock"]

    def test_bedrock_mode_off_keeps_anthropic_config(self):
        config = build_model_config("anthropic", "claude-sonnet-4-6", {})

        assert config["model"] == "anthropic/claude-sonnet-4-6"
        assert "small_model" not in config
        assert set(config["provider"]) == {"anthropic"}
        assert set(config["provider"]["anthropic"]["models"]) == set(BEDROCK_MODEL_SNAPSHOTS)
        assert config["provider"]["anthropic"]["models"]["claude-opus-4-5"] == {
            "variants": {
                "high": {"thinking": {"type": "enabled", "budgetTokens": 16_000}},
                "max": {"thinking": {"type": "enabled", "budgetTokens": 31_999}},
            }
        }

    def test_non_anthropic_provider_unaffected_by_bedrock_mode(self):
        config = build_model_config("openai", "gpt-5.6-sol", BEDROCK_ENV)

        assert config == build_model_config("openai", "gpt-5.6-sol", {})
        assert config["model"] == "openai/gpt-5.6-sol"
        assert "amazon-bedrock" not in config["provider"]


class TestOpenCodeServerStart:
    async def test_bedrock_mode_config_and_env_reach_opencode_serve(self, tmp_path):
        server = make_opencode_server(
            session_env("anthropic", "claude-sonnet-4-6"), workspace_path=tmp_path
        )
        with patch.dict(os.environ, BEDROCK_ENV):
            env = await start_opencode_capturing_env(server, tmp_path)

        config = json.loads(env["OPENCODE_CONFIG_CONTENT"])
        assert config["model"] == "amazon-bedrock/anthropic.claude-sonnet-4-6"
        assert config["provider"]["amazon-bedrock"]["options"] == {"region": "us-west-2"}
        assert "anthropic" not in config["provider"]
        assert {name: env[name] for name in BEDROCK_ENV} == BEDROCK_ENV
        # The control plane's catalog id is untouched.
        assert (server.provider, server.model) == ("anthropic", "claude-sonnet-4-6")

    async def test_bedrock_mode_off_emits_anthropic_model(self, tmp_path):
        server = make_opencode_server(
            session_env("anthropic", "claude-sonnet-4-6"), workspace_path=tmp_path
        )
        with patch.dict(os.environ, {"CLAUDE_CODE_USE_BEDROCK": "0"}):
            env = await start_opencode_capturing_env(server, tmp_path)

        config = json.loads(env["OPENCODE_CONFIG_CONTENT"])
        assert config["model"] == "anthropic/claude-sonnet-4-6"
        assert set(config["provider"]) == {"anthropic"}

    async def test_non_anthropic_provider_unaffected(self, tmp_path):
        server = make_opencode_server(session_env("openai", "gpt-5.6-sol"), workspace_path=tmp_path)
        with patch.dict(os.environ, BEDROCK_ENV):
            env = await start_opencode_capturing_env(server, tmp_path)

        config = json.loads(env["OPENCODE_CONFIG_CONTENT"])
        assert config["model"] == "openai/gpt-5.6-sol"
        assert "amazon-bedrock" not in config["provider"]


class TestPromptModelOverride:
    @pytest.fixture
    def bridge(self) -> AgentBridge:
        bridge = AgentBridge(
            sandbox_id="test-sandbox",
            session_id="test-session",
            control_plane_url="http://localhost:8787",
            auth_token="test-token",
        )
        bridge.harness.session_id = "oc-session-123"
        wire_opencode_transport(bridge, MagicMock())
        return bridge

    def test_bedrock_mode_translates_prompt_model_and_keeps_variant(self, bridge: AgentBridge):
        with patch.dict(os.environ, BEDROCK_ENV):
            body = bridge.harness.prompt_stream._build_prompt_request_body(
                "Hello", "anthropic/claude-opus-4-5", reasoning_effort="max"
            )

        assert body["model"] == {
            "providerID": "amazon-bedrock",
            "modelID": "anthropic.claude-opus-4-5-20251101-v1:0",
        }
        assert body["variant"] == "max"

    def test_bedrock_mode_off_keeps_anthropic_prompt_model(self, bridge: AgentBridge):
        with patch.dict(os.environ, {"CLAUDE_CODE_USE_BEDROCK": "0"}):
            body = bridge.harness.prompt_stream._build_prompt_request_body(
                "Hello", "claude-haiku-4-5", reasoning_effort="high"
            )

        assert body["model"] == {"providerID": "anthropic", "modelID": "claude-haiku-4-5"}
        assert body["variant"] == "high"

    def test_bedrock_mode_leaves_other_providers_alone(self, bridge: AgentBridge):
        with patch.dict(os.environ, BEDROCK_ENV):
            body = bridge.harness.prompt_stream._build_prompt_request_body(
                "Hello", "openai/gpt-5.6-sol"
            )

        assert body["model"] == {"providerID": "openai", "modelID": "gpt-5.6-sol"}
