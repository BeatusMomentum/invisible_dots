#!/bin/bash
set -euo pipefail
cd /app
cat > server.py <<'EOF'
import json
from http.server import BaseHTTPRequestHandler, HTTPServer

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            body = json.dumps({"status": "ok"}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()

HTTPServer(("127.0.0.1", 8765), Handler).serve_forever()
EOF
nohup setsid python3 server.py > server.log 2>&1 < /dev/null &
echo $! > server.pid
sleep 1
