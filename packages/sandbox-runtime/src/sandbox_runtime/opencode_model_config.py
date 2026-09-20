"""The ``model``/``provider`` portion of the generated opencode.json.

The session's catalog model (``<provider>/<model>``) is what the control plane
knows; this module decides which provider and model id OpenCode is actually
handed. Outside Bedrock mode that is the catalog id verbatim. In Bedrock mode
Anthropic models are served by OpenCode's ``amazon-bedrock`` provider instead,
so a sandbox with only a Bedrock API key never calls api.anthropic.com.
"""

from __future__ import annotations

import os
from typing import TYPE_CHECKING, Any, Final

from .harness.bedrock import (
    ANTHROPIC_PROVIDER_ID,
    AWS_REGION_ENV_VAR,
    BEDROCK_PROVIDER_ID,
    bedrock_model_id,
    opencode_model_target,
)
from .harness.claude import THINKING_BUDGET_MODELS, THINKING_BUDGETS

if TYPE_CHECKING:
    from collections.abc import Mapping

# OpenCode's title/summary model. Its own Bedrock pick is the ``global.`` Haiku
# inference profile; pinning the plain id makes it take the same regional
# (``us.``/``eu.``) profile as the session model instead.
BEDROCK_SMALL_MODEL: Final = "claude-haiku-4-5"

# Per-SDK shape of an explicit thinking budget in a model variant.
# ``@ai-sdk/anthropic`` reads ``thinking``; ``@ai-sdk/amazon-bedrock`` reads
# ``reasoningConfig`` (see OpenCode's ``ProviderTransform.variants``).
_THINKING_OPTION_KEY = {
    ANTHROPIC_PROVIDER_ID: "thinking",
    BEDROCK_PROVIDER_ID: "reasoningConfig",
}


def _thinking_variants(provider_id: str) -> dict[str, Any]:
    key = _THINKING_OPTION_KEY[provider_id]
    return {
        "variants": {
            effort: {key: {"type": "enabled", "budgetTokens": budget}}
            for effort, budget in THINKING_BUDGETS.items()
        }
    }


def build_model_config(
    provider: str, model: str, environ: Mapping[str, str] = os.environ
) -> dict[str, Any]:
    """``{"model": ..., "provider": {...}}`` for the session's catalog model.

    The two-value-ladder Claude models get explicit ``high``/``max`` thinking
    budgets so switching to them mid-session keeps the catalog's efforts. In
    Bedrock mode those variants move under ``amazon-bedrock`` (with the
    Bedrock model ids), the region comes from ``AWS_REGION``, and the session
    model is declared so OpenCode accepts it even before models.dev lists it.
    """
    provider_id, model_id = opencode_model_target(provider, model, environ)
    config: dict[str, Any] = {"model": f"{provider_id}/{model_id}"}

    if provider_id == BEDROCK_PROVIDER_ID:
        config["small_model"] = f"{BEDROCK_PROVIDER_ID}/{bedrock_model_id(BEDROCK_SMALL_MODEL)}"
        bedrock: dict[str, Any] = {"models": {model_id: {}}}
        region = environ.get(AWS_REGION_ENV_VAR)
        if region:
            bedrock["options"] = {"region": region}
        for catalog_model in sorted(THINKING_BUDGET_MODELS):
            bedrock["models"][bedrock_model_id(catalog_model)] = _thinking_variants(provider_id)
        config["provider"] = {BEDROCK_PROVIDER_ID: bedrock}
    else:
        config["provider"] = {
            ANTHROPIC_PROVIDER_ID: {
                "models": {
                    catalog_model: _thinking_variants(ANTHROPIC_PROVIDER_ID)
                    for catalog_model in sorted(THINKING_BUDGET_MODELS)
                }
            }
        }
    return config
