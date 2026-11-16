"""Stand-in for the Midtrans Snap API in end-to-end tests: accepts any transaction."""
import json
from http.server import BaseHTTPRequestHandler, HTTPServer


class Stub(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        order = body["transaction_details"]["order_id"]
        out = json.dumps({"token": f"stub-{order}", "redirect_url": f"https://stub.invalid/pay/{order}"}).encode()
        self.send_response(201)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)


HTTPServer(("0.0.0.0", 8000), Stub).serve_forever()
