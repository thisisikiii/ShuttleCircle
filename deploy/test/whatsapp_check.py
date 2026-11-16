"""Checks the WhatsApp link and invitation endpoints on the test copy (run from ~/sctest/deploy)."""
import json, ssl, subprocess, time, urllib.request

BASE = "https://localhost:8443/api/v1"
CTX = ssl._create_unverified_context()


def call(method, path, body=None, token=None):
    req = urllib.request.Request(BASE + path, method=method, data=json.dumps(body).encode() if body is not None else None)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, context=CTX, timeout=60) as r:
            raw = r.read()
            return r.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        raw = e.read()
        return e.code, json.loads(raw) if raw else None


def check(ok, label, extra=""):
    print(("  ok   " if ok else "  FAIL ") + label, "" if ok else extra)


run = str(int(time.time()))
email = f"wa-{run}@test.id"
s, b = call("POST", "/auth/register", {"email": email, "password": "password-123", "full_name": "Uji WA"})
subprocess.run(["docker", "compose", "exec", "-T", "api", "shuttlecircle", "create-superadmin", "--email", email], check=True, capture_output=True)
s, b = call("POST", "/auth/login", {"email": email, "password": "password-123"})
root = b["data"]["access_token"]
s, b = call("POST", "/auth/register", {"email": f"wm-{run}@test.id", "password": "password-123", "full_name": "Anggota"})
member = b["data"]["access_token"]

s, b = call("GET", "/healthz")
check(b["features"]["whatsapp"] is True, "healthz reports whatsapp on", str(b))
s, b = call("GET", "/whatsapp", token=member)
check(s == 403, "member cannot read whatsapp status", str(s))

qr = None
for _ in range(15):
    s, b = call("GET", "/whatsapp", token=root)
    if s == 200 and b["data"].get("qr"):
        qr = b["data"]["qr"]
        break
    time.sleep(2)
check(s == 200 and b["data"]["enabled"] and b["data"]["status"] == "SCAN_QR_CODE", "status reaches SCAN_QR_CODE", str(b)[:200])
check(bool(qr) and qr.startswith("data:image/png;base64,") and len(qr) > 1000, "QR code is a PNG data URL")

s, b = call("POST", "/invitations", {"contacts": ["a@test.id"]}, token=member)
check(s == 403, "member cannot invite", str(s))
s, b = call("POST", "/invitations", {"contacts": []}, token=root)
check(s == 422, "empty contact list rejected", str(s))
s, b = call("POST", "/invitations", {"contacts": ["x"] * 21}, token=root)
check(s == 422, "more than 20 contacts rejected", str(s))
s, b = call("POST", "/invitations", {"contacts": ["teman@test.id", "0812-0000-0000", "123"]}, token=root)
res = {r["contact"]: r for r in b["data"]} if s == 200 else {}
check(s == 200 and len(res) == 3 and not any(r["sent"] for r in res.values()), "register invite answers per contact", str(b)[:300])
check(res.get("teman@test.id", {}).get("error") == "Email belum diatur", "email contact: not configured", str(res))
check(res.get("0812-0000-0000", {}).get("error") == "WhatsApp belum terhubung", "phone contact: not linked", str(res))
check(res.get("123", {}).get("error") == "Nomor WhatsApp tidak valid", "bad number rejected", str(res))

start = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + 86400))
s, b = call("POST", "/matches", {"title": f"WA {run}", "location_name": "GOR", "location_maps_url": "https://maps.app.goo.gl/x", "starts_at": start,
                                 "duration_hours": 2, "capacity": 4, "match_type": "intermediate", "racket_provided": False, "shuttlecock_provided": True,
                                 "court_cost_per_hour_idr": 0, "price_idr": 10000}, token=root)
check(s == 201, "match created", str(b)[:200])
mid = b["data"]["id"]
s, b = call("POST", "/invitations", {"match_id": mid, "contacts": ["teman@test.id"]}, token=root)
check(s == 200 and b["data"][0]["sent"] is False, "match invite answers", str(b)[:200])
s, b = call("POST", "/invitations", {"match_id": "00000000-0000-0000-0000-000000000000", "contacts": ["teman@test.id"]}, token=root)
check(s == 404, "unknown match is 404", str(s))
s, b = call("POST", "/whatsapp/logout", token=member)
check(s == 403, "member cannot unlink", str(s))
