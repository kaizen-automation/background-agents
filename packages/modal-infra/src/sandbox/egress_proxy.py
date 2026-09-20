"""Optional Modal Proxy for fixed-IP sandbox egress."""

import os
from typing import Any

import modal

# Name of a Modal Proxy in the deployment's Modal environment. When set, every
# sandbox routes its outbound traffic through the proxy's static IPs so they can
# be allow-listed at private data sources. Delivered via the internal-api secret.
MODAL_PROXY_NAME_ENV = "MODAL_PROXY_NAME"


def sandbox_proxy_kwargs() -> dict[str, Any]:
    """Return the `proxy=` kwarg for `modal.Sandbox.create`, or `{}` when unset."""
    name = os.environ.get(MODAL_PROXY_NAME_ENV, "").strip()
    if not name:
        return {}
    return {"proxy": modal.Proxy.from_name(name)}
