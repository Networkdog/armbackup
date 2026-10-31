"""Minimal App Service host; never serves local files or configuration."""

import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Health(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        if self.path not in {"/", "/health"}:
            self.send_error(404)
            return
        body = b'{"service":"armbackup","host":"ready","backupHealth":"check Log Analytics"}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", int(os.environ.get("PORT", "8000"))), Health).serve_forever()
