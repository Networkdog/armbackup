import threading
from http.server import ThreadingHTTPServer

import pytest
import requests

from armbackup.webui import ASSETS, CSP, PreviewHandler, main


@pytest.fixture
def preview_url():
    server = ThreadingHTTPServer(("127.0.0.1", 0), PreviewHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


@pytest.mark.parametrize("path", list(ASSETS))
def test_preview_assets_are_packaged_and_served_locally(preview_url, path):
    response = requests.get(preview_url + path, timeout=5)
    assert response.status_code == 200
    assert response.content
    assert response.headers["Content-Type"] == ASSETS[path][1]
    assert response.headers["Content-Security-Policy"] == CSP
    assert "connect-src 'self'" in response.headers["Content-Security-Policy"]
    assert "https:" not in response.headers["Content-Security-Policy"]
    assert response.headers["X-Content-Type-Options"] == "nosniff"
    assert response.headers["Cache-Control"] == "no-store"
    assert int(response.headers["Content-Length"]) == len(response.content)


def test_health_explicitly_reports_no_azure_connection(preview_url):
    response = requests.get(preview_url + "/health", timeout=5)
    assert response.json() == {
        "status": "ok", "mode": "design-preview", "azureConnected": False,
    }


def test_head_has_headers_but_no_body(preview_url):
    response = requests.head(preview_url + "/", timeout=5)
    assert response.status_code == 200
    assert response.content == b""
    assert int(response.headers["Content-Length"]) > 0


@pytest.mark.parametrize("path", [
    "/config.json", "/.git/config", "/%2e%2e/config.json",
    "/src/armbackup/config.py", "/api/restore", "/ui_static/",
])
def test_preview_does_not_expose_files_or_operational_api(preview_url, path):
    assert requests.get(preview_url + path, timeout=5).status_code == 404


def test_no_restore_post_endpoint(preview_url):
    assert requests.post(preview_url + "/api/restore", json={}, timeout=5).status_code == 501


@pytest.mark.parametrize("port", ["0", "-1", "65536"])
def test_invalid_preview_port_is_rejected(port):
    with pytest.raises(SystemExit) as exc:
        main(["--port", port])
    assert exc.value.code == 2
