"""Local static server for development: like `python3 -m http.server` but with caching disabled,
so browsers always pick up the latest JS/CSS/data after an edit. It also stamps the `?v=__BUILD__`
placeholders (which the GitHub Pages workflow replaces with the commit hash) with the newest file
modification time, so even modules a browser cached earlier are re-requested under a new URL.

Usage:  python3 tools/serve.py [port]      (serves the repository root; open /web/index.html)
"""
import functools
import http.server
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def build_token():
    newest = 0
    for base, _, files in os.walk(os.path.join(ROOT, "web")):
        for f in files:
            if f.endswith((".js", ".css", ".html")):
                newest = max(newest, int(os.path.getmtime(os.path.join(base, f))))
    return str(newest).encode()


class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        path = self.translate_path(self.path.split("?")[0])
        if os.path.isfile(path) and path.endswith((".js", ".css", ".html")):
            body = open(path, "rb").read().replace(b"__BUILD__", build_token())
            self.send_response(200)
            self.send_header("Content-Type", self.guess_type(path))
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            super().do_GET()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    handler = functools.partial(NoCache, directory=ROOT)
    print(f"Serving {ROOT} at http://localhost:{port}/web/index.html (no caching)")
    http.server.ThreadingHTTPServer(("", port), handler).serve_forever()
