"""Local static server for development: like `python3 -m http.server` but with caching disabled,
so browsers always pick up the latest JS/CSS/data after an edit.

Usage:  python3 tools/serve.py [port]      (serves the repository root; open /web/index.html)
"""
import functools
import http.server
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    handler = functools.partial(NoCache, directory=ROOT)
    print(f"Serving {ROOT} at http://localhost:{port}/web/index.html (no caching)")
    http.server.ThreadingHTTPServer(("", port), handler).serve_forever()
