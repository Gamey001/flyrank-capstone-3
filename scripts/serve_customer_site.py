#!/usr/bin/env python3
"""Serves customer-site/ on a different port from the API, which makes it a
different origin — the condition the CORS half of this project exists for.
Local development only."""

import argparse
import http.server
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "customer-site"


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args: object, **kwargs: object) -> None:
        super().__init__(*args, directory=str(ROOT), **kwargs)  # type: ignore[arg-type]

    def end_headers(self) -> None:
        self.send_header("cache-control", "no-store")
        super().end_headers()

    def log_message(self, fmt: str, *args: object) -> None:
        pass  # the request log is noise next to the API's


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=int(os.environ.get("SITE_PORT", 5500)))
    args = parser.parse_args()

    server = http.server.ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"Customer test site: http://localhost:{args.port}  " "(a different origin from the API)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()


if __name__ == "__main__":
    main()
