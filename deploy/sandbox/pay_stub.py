"""Sandbox stand-in for Midtrans Snap with a checkout page a tester clicks through by hand.

POST /snap/v1/transactions     (from the API) remembers the amount, returns a redirect to the page below
GET  /sandbox-pay/<order>      checkout page: pay, or let it expire
POST /sandbox-pay/<order>      sends the signed notification Midtrans would send to the API webhook
Never run this next to a real MIDTRANS_SERVER_KEY: it signs notifications with that key.
"""
import hashlib
import html
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

KEY = os.environ["MIDTRANS_SERVER_KEY"]
DOMAIN = os.environ["DOMAIN"]
WEBHOOK = "http://api:8080/api/v1/webhooks/midtrans"
orders = {}  # order_id -> amount; shortcut: in memory, lost on restart (the tester just pays again)


def page(title, body):
    return f"""<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title}</title><style>body{{font-family:system-ui,sans-serif;max-width:28rem;margin:3rem auto;padding:0 1rem;color:#0f172a}}
.tag{{background:#fef3c7;color:#92400e;padding:.25rem .6rem;border-radius:99px;font-size:.8rem;font-weight:700}}
button,a.b{{display:block;width:100%;min-height:2.75rem;margin:.5rem 0;border-radius:.75rem;font-weight:700;font-size:1rem;border:1px solid #cbd5e1;background:#fff;cursor:pointer;text-align:center;line-height:2.75rem;text-decoration:none;color:#0f172a}}
button.pay{{background:#047857;color:#fff;border:0}}</style></head><body><p><span class="tag">SANDBOX · bukan pembayaran asli</span></p>{body}</body></html>"""


class Stub(BaseHTTPRequestHandler):
    def send(self, code, body, ctype="text/html; charset=utf-8"):
        data = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def order(self):
        return urllib.parse.unquote(self.path.split("/sandbox-pay/", 1)[1].split("?")[0])

    def do_GET(self):
        if not self.path.startswith("/sandbox-pay/"):
            return self.send(404, page("Tidak ditemukan", "<p>Tidak ditemukan.</p>"))
        o = self.order()
        amount = orders.get(o)
        if amount is None:
            return self.send(404, page("Tidak ditemukan", "<p>Transaksi tidak dikenal (stub dimulai ulang?). Minta pembayaran baru dari aplikasi.</p>"))
        self.send(200, page("Checkout sandbox", f"""<h1>Checkout sandbox</h1><p>Order <code>{html.escape(o)}</code></p>
<p style="font-size:2rem;font-weight:800">Rp {f"{amount:,}".replace(",", ".")}</p>
<form method="post"><button class="pay" name="status" value="settlement">Bayar (simulasi berhasil)</button>
<button name="status" value="expire">Biarkan kedaluwarsa</button><button name="status" value="deny">Tolak pembayaran</button></form>"""))

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        if self.path.startswith("/snap/"):
            req = json.loads(body)
            o, amount = req["transaction_details"]["order_id"], int(req["transaction_details"]["gross_amount"])
            orders[o] = amount
            out = {"token": f"sandbox-{o}", "redirect_url": f"https://{DOMAIN}/sandbox-pay/{urllib.parse.quote(o)}"}
            return self.send(201, json.dumps(out), "application/json")
        o = self.order()
        status = urllib.parse.parse_qs(body.decode()).get("status", [""])[0]
        if o not in orders or status not in ("settlement", "expire", "deny"):
            return self.send(400, page("Gagal", "<p>Permintaan tidak valid.</p>"))
        gross, code = f"{orders[o]}.00", "200" if status == "settlement" else "202"
        note = {"order_id": o, "status_code": code, "gross_amount": gross, "transaction_status": status,
                "signature_key": hashlib.sha512(f"{o}{code}{gross}{KEY}".encode()).hexdigest()}
        req = urllib.request.Request(WEBHOOK, json.dumps(note).encode(), {"Content-Type": "application/json"})
        try:
            result = urllib.request.urlopen(req, timeout=10).status
        except urllib.error.HTTPError as e:
            result = e.code
        label = {"settlement": "Pembayaran berhasil dikirim ke aplikasi.", "expire": "Pembayaran ditandai kedaluwarsa.", "deny": "Pembayaran ditolak."}[status]
        self.send(200, page("Selesai", f"<h1>{label}</h1><p>Webhook menjawab {result}.</p><a class='b' href='/'>Kembali ke ShuttleCircle</a>"))


ThreadingHTTPServer(("0.0.0.0", 8000), Stub).serve_forever()
