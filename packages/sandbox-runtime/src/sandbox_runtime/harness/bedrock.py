"""Catalog model → Amazon Bedrock model id, shared by both harnesses.

The control plane only ever speaks the catalog id (``anthropic/<model>``).
When the sandbox runs in Bedrock mode (``CLAUDE_CODE_USE_BEDROCK`` with an
``AWS_BEARER_TOKEN_BEDROCK``), each harness translates that id for its own
runtime at the last moment: Claude Code takes the snapshot name and resolves
the regional inference profile itself; OpenCode's ``amazon-bedrock`` provider
takes the Bedrock model id and prefixes the region (``us.`` for ``us-*``)
itself. Both translations start from the one table below so they cannot drift.
"""

from __future__ import annotations

import os
from typing import TYPE_CHECKING, Final

from .claude_env import BEDROCK_TOKEN_ENV_VAR, bedrock_enabled

if TYPE_CHECKING:
    from collections.abc import Mapping

ANTHROPIC_PROVIDER_ID: Final = "anthropic"
# OpenCode's provider id for Amazon Bedrock (``@ai-sdk/amazon-bedrock``).
BEDROCK_PROVIDER_ID: Final = "amazon-bedrock"
AWS_REGION_ENV_VAR: Final = "AWS_REGION"

# Bedrock only resolves dated snapshot ids for these; Claude Code maps the
# snapshot name to the regional inference profile itself.
BEDROCK_MODEL_SNAPSHOTS: Final = {
    "claude-haiku-4-5": "claude-haiku-4-5-20251001",
    "claude-sonnet-4-5": "claude-sonnet-4-5-20250929",
    "claude-opus-4-5": "claude-opus-4-5-20251101",
}
# Dated snapshots carry Bedrock's version suffix; newer models are versionless
# except Opus 4.6, which Bedrock published as ``-v1``.
_SNAPSHOT_VERSION_SUFFIX: Final = "-v1:0"
_MODEL_VERSION_SUFFIXES: Final = {"claude-opus-4-6": "-v1"}


def bedrock_mode_active(environ: Mapping[str, str] = os.environ) -> bool:
    """Bedrock is switched on and a Bedrock API key is present."""
    return bedrock_enabled(environ) and bool(environ.get(BEDROCK_TOKEN_ENV_VAR))


def bedrock_model_id(model: str) -> str:
    """The unprefixed Bedrock model id for a catalog Anthropic model.

    OpenCode adds the cross-region inference-profile prefix (``us.``, ``eu.``,
    ...) from the configured region, so the id stays region-neutral here.
    """
    snapshot = BEDROCK_MODEL_SNAPSHOTS.get(model)
    if snapshot is not None:
        return f"anthropic.{snapshot}{_SNAPSHOT_VERSION_SUFFIX}"
    return f"anthropic.{model}{_MODEL_VERSION_SUFFIXES.get(model, '')}"


def opencode_model_target(
    provider: str, model: str, environ: Mapping[str, str] = os.environ
) -> tuple[str, str]:
    """The ``(providerID, modelID)`` OpenCode is handed for a catalog model.

    Only Anthropic models move to Bedrock; every other provider, and Anthropic
    outside Bedrock mode, passes through unchanged.
    """
    if provider == ANTHROPIC_PROVIDER_ID and bedrock_mode_active(environ):
        return BEDROCK_PROVIDER_ID, bedrock_model_id(model)
    return provider, model
