"""JSON-over-HTTP service (standard library only).

    python -m limen.service --port 8088

    GET  /health          liveness
    GET  /v1/contracts    endpoint table + JSON Schemas
    POST /v1/...          see limen.contracts.ENDPOINTS

Bind to localhost / a private network only: the Node.js app is the sole
caller and is responsible for authenticating users.
"""
from __future__ import annotations

import argparse
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from . import __version__
from .api import Engine
from .llm import llm_from_env

MAX_BODY_BYTES = 2_000_000


def make_handler(engine: Engine) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        server_version = f"limen-core/{__version__}"

        def _send(self, status: int, payload: dict) -> None:
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self) -> None:  # noqa: N802
            if self.path == "/health":
                self._send(200, {"status": "ok", "version": __version__})
            elif self.path == "/v1/contracts":
                self._send(200, engine.contracts())
            else:
                self._send(404, {"error": {"code": "NOT_FOUND", "message": f"no such endpoint: {self.path}"}})

        def do_POST(self) -> None:  # noqa: N802
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > MAX_BODY_BYTES:
                self._send(413 if length > MAX_BODY_BYTES else 400,
                           {"error": {"code": "INVALID_REQUEST", "message": "a JSON body of at most 2 MB is required"}})
                return
            try:
                body = json.loads(self.rfile.read(length))
            except (ValueError, UnicodeDecodeError):
                self._send(400, {"error": {"code": "INVALID_JSON", "message": "request body is not valid JSON"}})
                return
            try:
                status, payload = engine.handle(self.path, body)
            except Exception:  # fail closed, no internals in the response
                self.log_error("unhandled error on %s", self.path)
                status, payload = 500, {"error": {"code": "INTERNAL_ERROR", "message": "the request could not be processed"}}
            self._send(status, payload)

        def log_message(self, fmt: str, *args) -> None:  # keep request bodies and limits out of logs
            pass

    return Handler


def serve(host: str = "127.0.0.1", port: int = 8088, engine: Engine | None = None) -> ThreadingHTTPServer:
    return ThreadingHTTPServer((host, port), make_handler(engine or Engine(llm=llm_from_env())))


def main() -> None:
    ap = argparse.ArgumentParser(description="Limen Core Intelligence Engine")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8088)
    args = ap.parse_args()
    server = serve(args.host, args.port)
    print(f"limen-core {__version__} listening on http://{args.host}:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
