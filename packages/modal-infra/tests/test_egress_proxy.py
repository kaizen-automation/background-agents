"""Optional Modal Proxy attachment for session and image-build sandboxes."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from src.sandbox.build_session import ModalBuildSessionService
from src.sandbox.egress_proxy import MODAL_PROXY_NAME_ENV, sandbox_proxy_kwargs
from src.sandbox.manager import SandboxConfig, SandboxManager


def _stub_proxy_lookup(monkeypatch):
    proxy = object()
    from_name = MagicMock(return_value=proxy)
    monkeypatch.setattr("src.sandbox.egress_proxy.modal.Proxy.from_name", from_name)
    return proxy, from_name


@pytest.mark.parametrize("value", [None, "", "   "])
def test_no_proxy_when_unset_or_blank(monkeypatch, value):
    if value is None:
        monkeypatch.delenv(MODAL_PROXY_NAME_ENV, raising=False)
    else:
        monkeypatch.setenv(MODAL_PROXY_NAME_ENV, value)
    _, from_name = _stub_proxy_lookup(monkeypatch)

    assert sandbox_proxy_kwargs() == {}
    from_name.assert_not_called()


def test_proxy_resolved_by_name(monkeypatch):
    monkeypatch.setenv(MODAL_PROXY_NAME_ENV, " kaizen-code-egress ")
    proxy, from_name = _stub_proxy_lookup(monkeypatch)

    assert sandbox_proxy_kwargs() == {"proxy": proxy}
    from_name.assert_called_once_with("kaizen-code-egress")


@pytest.mark.asyncio
async def test_session_sandbox_attaches_proxy(monkeypatch):
    monkeypatch.setenv(MODAL_PROXY_NAME_ENV, "egress")
    monkeypatch.delenv("SCM_PROVIDER", raising=False)
    proxy, _ = _stub_proxy_lookup(monkeypatch)
    captured: dict = {}

    async def create_aio(*args, **kwargs):
        captured["kwargs"] = kwargs
        return SimpleNamespace(object_id="modal-object-1", stdout=None)

    create_aio.aio = create_aio
    monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.create", create_aio)
    monkeypatch.setattr(
        SandboxManager,
        "_resolve_and_setup_tunnels",
        AsyncMock(return_value=(None, None, None, None)),
    )

    await SandboxManager().create_sandbox(
        SandboxConfig(repo_owner="acme", repo_name="repo", sandbox_id="sandbox-1")
    )

    assert captured["kwargs"]["proxy"] is proxy


@pytest.mark.asyncio
async def test_build_sandbox_attaches_proxy(monkeypatch):
    monkeypatch.setenv(MODAL_PROXY_NAME_ENV, "egress")
    proxy, _ = _stub_proxy_lookup(monkeypatch)
    create = MagicMock()
    create.aio = AsyncMock(return_value=SimpleNamespace(object_id="modal-session-1"))
    monkeypatch.setattr("src.sandbox.build_session.modal.Sandbox.create", create)

    await ModalBuildSessionService().create(
        build_id="build-1",
        scope_kind="repo",
        scope_id="acme/repo",
        repositories=[{"repo_owner": "acme", "repo_name": "repo", "branch": "main"}],
        callback_url="https://cp.test/complete",
        failure_callback_url="https://cp.test/failed",
    )

    assert create.aio.await_args.kwargs["proxy"] is proxy
