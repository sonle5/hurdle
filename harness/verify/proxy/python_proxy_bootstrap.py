"""Python bootstrap for selective evaluation egress capture.

This module is installed as ``sitecustomize.py`` in the sandbox. It keeps the
eval proxy's CA trusted and routes only declared capture-host requests made with
``aiohttp`` through the capture proxy. Other destinations retain aiohttp's
normal behavior.
"""

from __future__ import annotations

import functools
import importlib
import json
import os
import socket
import ssl
import urllib.request
from urllib.parse import urljoin, urlsplit


_BUNDLE = os.environ.get("TAE_EGRESS_CA_BUNDLE", "")
_PROXY = os.environ.get("TAE_EGRESS_PROXY", "")
_EGRESS_SMOKE = os.environ.get("TOGETHER_EGRESS_SMOKE") == "1"
_EGRESS_SMOKE_HEADER = "X-Together-Eval-Egress-Smoke-Client"
if "TAE_EGRESS_CAPTURE_HOSTS" not in os.environ:
    _CAPTURE_HOSTS = frozenset()
else:
    try:
        _CAPTURE_HOSTS = frozenset(
            str(host).lower()
            for host in json.loads(os.environ["TAE_EGRESS_CAPTURE_HOSTS"])
        )
    except (TypeError, ValueError, json.JSONDecodeError):
        _CAPTURE_HOSTS = frozenset()


def _install_ca_bundle() -> None:
    if not (_BUNDLE and os.path.exists(_BUNDLE)):
        return

    os.environ.setdefault("SSL_CERT_FILE", _BUNDLE)
    os.environ.setdefault("REQUESTS_CA_BUNDLE", _BUNDLE)
    os.environ.setdefault("CURL_CA_BUNDLE", _BUNDLE)
    os.environ.setdefault("PIP_CERT", _BUNDLE)

    def _where() -> str:
        return _BUNDLE

    def _contents() -> str:
        with open(_BUNDLE, "r", encoding="ascii") as handle:
            return handle.read()

    try:
        import certifi

        certifi.where = _where
        certifi.contents = _contents
    except Exception:
        pass

    try:
        import certifi.core

        certifi.core.where = _where
        certifi.core.contents = _contents
    except Exception:
        pass


def _target_host(session: object, raw_url: object) -> str:
    """Resolve absolute and ClientSession(base_url=...) request hosts."""

    try:
        value = str(raw_url)
        parsed = urlsplit(value)
        if not parsed.hostname:
            base_url = getattr(session, "_base_url", None)
            if base_url is not None:
                value = urljoin(str(base_url), value)
                parsed = urlsplit(value)
        return (parsed.hostname or "").lower().rstrip(".")
    except (TypeError, ValueError):
        return ""


def _install_urllib_smoke_marker() -> None:
    if not _EGRESS_SMOKE:
        return

    original_init = urllib.request.Request.__init__
    if getattr(original_init, "_together_egress_smoke_marker", False):
        return

    @functools.wraps(original_init)
    def marked_request_init(self, url, *args, **kwargs):
        original_init(self, url, *args, **kwargs)
        if _target_host(None, self.full_url) in _CAPTURE_HOSTS:
            self.add_unredirected_header(
                _EGRESS_SMOKE_HEADER,
                "python-urllib",
            )

    marked_request_init._together_egress_smoke_marker = True
    urllib.request.Request.__init__ = marked_request_init


def _install_aiohttp_routing() -> None:
    if not _PROXY:
        return

    try:
        import aiohttp
    except ImportError:
        return

    original_request = aiohttp.ClientSession._request
    if not getattr(original_request, "_together_host_proxy", False):

        @functools.wraps(original_request)
        async def proxy_together_request(self, method, url, *args, **kwargs):
            # Preserve an explicit caller choice, including proxy=None.
            if (
                "proxy" not in kwargs
                and _target_host(self, url) in _CAPTURE_HOSTS
            ):
                kwargs["proxy"] = _PROXY
            return await original_request(self, method, url, *args, **kwargs)

        proxy_together_request._together_host_proxy = True
        aiohttp.ClientSession._request = proxy_together_request

    # ws_connect() binds its omitted proxy argument to None before eventually
    # reaching _request(), so intercept it at the public boundary where an
    # omitted proxy can still be distinguished from an explicit proxy=None.
    original_ws_connect = aiohttp.ClientSession.ws_connect
    if not getattr(original_ws_connect, "_together_host_proxy", False):

        @functools.wraps(original_ws_connect)
        def proxy_together_websocket(self, url, *args, **kwargs):
            if (
                "proxy" not in kwargs
                and _target_host(self, url) in _CAPTURE_HOSTS
            ):
                kwargs["proxy"] = _PROXY
            return original_ws_connect(self, url, *args, **kwargs)

        proxy_together_websocket._together_host_proxy = True
        aiohttp.ClientSession.ws_connect = proxy_together_websocket


def _websocket_target(raw_url: object):
    try:
        parsed = urlsplit(str(raw_url))
        host = (parsed.hostname or "").lower().rstrip(".")
        port = parsed.port or 443
    except (TypeError, ValueError):
        return None
    if (
        parsed.scheme.lower() != "wss"
        or host not in _CAPTURE_HOSTS
        or port != 443
        or parsed.username is not None
        or parsed.password is not None
    ):
        return None
    return host, port


def _guardian_proxy_address():
    try:
        parsed = urlsplit(_PROXY)
        host = (parsed.hostname or "").lower().rstrip(".")
        port = parsed.port
    except (TypeError, ValueError):
        return None
    if (
        parsed.scheme.lower() != "http"
        or host not in {"127.0.0.1", "localhost"}
        or port is None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
    ):
        return None
    return host, port


def _connect_guardian_tunnel(host: str, port: int, timeout: float = 10.0):
    proxy = _guardian_proxy_address()
    if proxy is None:
        raise RuntimeError("Evaluation egress proxy must be a loopback HTTP proxy")
    connection = None
    try:
        connection = socket.create_connection(proxy, timeout=timeout)
        connection.settimeout(timeout)
        request = (
            f"CONNECT {host}:{port} HTTP/1.1\r\n"
            f"Host: {host}:{port}\r\n"
            "Proxy-Connection: keep-alive\r\n"
            "\r\n"
        ).encode("ascii")
        connection.sendall(request)
        response = bytearray()
        while b"\r\n\r\n" not in response:
            chunk = connection.recv(4096)
            if not chunk:
                raise RuntimeError("Evaluation egress proxy closed before the CONNECT response")
            response.extend(chunk)
            if len(response) > 16 * 1024:
                raise RuntimeError("Evaluation egress proxy returned an oversized CONNECT response")
        header, separator, trailing = bytes(response).partition(b"\r\n\r\n")
        status_line = header.split(b"\r\n", 1)[0]
        if separator != b"\r\n\r\n" or b" 200 " not in status_line:
            raise RuntimeError(
                "Evaluation egress proxy CONNECT failed: "
                + status_line.decode("latin1", "replace")
            )
        if trailing:
            raise RuntimeError("Evaluation egress proxy sent payload bytes before the TLS handshake")
        connection.settimeout(None)
        return connection
    except BaseException:
        if connection is not None:
            connection.close()
        raise


def _websockets_major_version(module: object):
    raw = str(getattr(module, "__version__", "")).split(".", 1)[0]
    return int(raw) if raw.isdigit() else None


def _websocket_connection_factory_name(connector: object):
    if callable(getattr(connector, "create_connection", None)):
        return "create_connection"
    if callable(getattr(connector, "_create_connection", None)):
        return "_create_connection"
    return None


def _install_guardian_connector_factory(
    connector: object,
    original_connect,
    uri,
    args,
    kwargs,
) -> None:
    factory_name = _websocket_connection_factory_name(connector)
    if factory_name is None:
        raise RuntimeError("Unsupported websockets connector for Together egress routing")

    async def guardian_create_connection():
        current_uri = getattr(connector, "uri", getattr(connector, "_uri", uri))
        target = _websocket_target(current_uri)
        attempt_kwargs = dict(kwargs)
        proxy_socket = None
        if target is not None:
            host, port = target
            if "ssl" not in attempt_kwargs:
                attempt_kwargs["ssl"] = ssl.create_default_context(cafile=_BUNDLE)
            proxy_socket = _connect_guardian_tunnel(host, port)
            attempt_kwargs["sock"] = proxy_socket
            attempt_kwargs.setdefault("server_hostname", host)
        try:
            attempt = original_connect(current_uri, *args, **attempt_kwargs)
            attempt_factory = getattr(attempt, factory_name, None)
            if not callable(attempt_factory):
                raise RuntimeError(
                    "Unsupported websockets connection attempt for Together egress routing"
                )
            return await attempt_factory()
        except BaseException:
            if proxy_socket is not None:
                proxy_socket.close()
            raise

    setattr(connector, factory_name, guardian_create_connection)


def _install_websockets_routing() -> None:
    if not (_PROXY and _BUNDLE and os.path.exists(_BUNDLE)):
        return
    try:
        import websockets
    except ImportError:
        return
    major = _websockets_major_version(websockets)
    # Issue #178 affects the async APIs exercised by websockets 12-14. Version
    # 15 adds native proxy support to the asyncio client while its deprecated
    # legacy compatibility imports still require this adapter.
    if major is None or major < 12 or major > 15:
        return

    modules = [websockets]
    for name in (
        "websockets.client",
        "websockets.legacy.client",
        "websockets.asyncio.client",
    ):
        try:
            modules.append(importlib.import_module(name))
        except ImportError:
            pass

    wrappers = {}
    for module in modules:
        original_connect = getattr(module, "connect", None)
        if original_connect is None:
            continue
        if (
            major == 15
            and getattr(original_connect, "__module__", "")
            != "websockets.legacy.client"
        ):
            continue
        if getattr(original_connect, "_together_guardian_websocket", False):
            continue
        wrapped_connect = wrappers.get(original_connect)
        if wrapped_connect is None:

            @functools.wraps(original_connect)
            def guardian_websocket_connect(
                uri,
                *args,
                __original=original_connect,
                **kwargs,
            ):
                target = _websocket_target(uri)
                # Preserve explicit caller routing, including sock=None.
                if target is None or "sock" in kwargs:
                    return __original(uri, *args, **kwargs)
                connector = __original(uri, *args, **kwargs)
                _install_guardian_connector_factory(
                    connector,
                    __original,
                    uri,
                    args,
                    kwargs,
                )
                return connector

            guardian_websocket_connect._together_guardian_websocket = True
            wrapped_connect = guardian_websocket_connect
            wrappers[original_connect] = wrapped_connect
        module.connect = wrapped_connect


_install_ca_bundle()
_install_urllib_smoke_marker()
_install_aiohttp_routing()
_install_websockets_routing()
