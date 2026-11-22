"""Checks manual payment (FR-22): payment details, QRIS upload, claim, confirm and reject.
Run from deploy/ of a test or sandbox stack: BASE=http://localhost:8091 python3 test/payment_check.py
It saves the current payment settings first and puts them back at the end, but its QRIS upload
deletes the old QRIS file: run it before seeding real details, never on production."""
import datetime as dt
import json
import os
import ssl
import subprocess
import sys
import urllib.error
import urllib.request
import uuid

DEPLOY = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = os.environ.get("BASE", "https://localhost")
CTX = ssl._create_unverified_context()
RUN = uuid.uuid4().hex[:6]
passed, failed = 0, []

# Smallest valid PNG (1x1), so the test needs no image file.
PNG = bytes.fromhex("89504e470d0a1a0a0000000d4948445200000001000000010806000000""1f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4040000000049454e44ae426082")


def check(cond, name, detail=""):
    global passed
    if cond:
        passed += 1
        print(f"  ok   {name}")
    else:
        failed.append(name)
        print(f"  FAIL {name} {detail}")


def call(method, path, body=None, token=None, raw=None, ctype="application/json"):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    headers = {"Content-Type": ctype} if data is not None else {}
    if token:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(BASE + "/api/v1" + path, data, headers, method=method)
    try:
        r = urllib.request.urlopen(req, context=CTX)
    except urllib.error.HTTPError as e:
        r = e
    out = r.read()
    try:
        return r.status, json.loads(out) if out else None
    except ValueError:
        return r.status, out


def register(name):
    email = f"{name.lower()}-{RUN}@test.id"
    s, j = call("POST", "/auth/register", {"email": email, "password": "password-123", "full_name": name})
    assert s == 200, (s, j)
    return email, j["data"]["access_token"]


def psql(sql):
    return subprocess.run(["docker", "compose", "exec", "-T", "db", "psql", "-U", "shuttlecircle", "-tAc", sql], cwd=DEPLOY, check=True, capture_output=True, text=True).stdout.strip()


print("1. setup")
saved = psql("SELECT row_to_json(s)::text FROM (SELECT pay_qris_path, pay_holder, pay_ewallet_number, pay_ewallet_names, pay_banks FROM settings) s")
root_email, _ = register("Kasir")
subprocess.run(["docker", "compose", "exec", "-T", "api", "shuttlecircle", "create-superadmin", "--email", root_email], cwd=DEPLOY, check=True, capture_output=True)
root = call("POST", "/auth/login", {"email": root_email, "password": "password-123"})[1]["data"]["access_token"]
_, member = register("Pembayar")
member_id = call("GET", "/me", token=member)[1]["data"]["id"]

try:
    print("2. payment details (superadmin only)")
    check(call("PATCH", "/settings", {"pay_ewallet_number": "081200000000"}, token=member)[0] == 403, "member cannot change payment details")
    check(call("PATCH", "/settings", {"pay_ewallet_number": "08-12"}, token=root)[0] == 422, "e-wallet number must be digits")
    check(call("PATCH", "/settings", {"pay_banks": [{"bank": "", "number": "123456"}]}, token=root)[0] == 422, "bank needs a name")
    s, j = call("PATCH", "/settings", {"pay_holder": "Klub Uji", "pay_ewallet_number": "081200000000", "pay_ewallet_names": "GoPay, DANA",
                                      "pay_banks": [{"bank": "BCA", "number": "1234567890"}]}, token=root)
    check(s == 200, "superadmin saves payment details", str(j))
    boundary = "x" + RUN
    form = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"q.png\"\r\nContent-Type: image/png\r\n\r\n").encode() + PNG + f"\r\n--{boundary}--\r\n".encode()
    check(call("POST", "/settings/qris", raw=form, token=member, ctype=f"multipart/form-data; boundary={boundary}")[0] == 403, "member cannot upload QRIS")
    bad = form.replace(PNG, b"not an image")
    check(call("POST", "/settings/qris", raw=bad, token=root, ctype=f"multipart/form-data; boundary={boundary}")[0] == 422, "QRIS must be an image")
    check(call("POST", "/settings/qris", raw=form, token=root, ctype=f"multipart/form-data; boundary={boundary}")[0] == 200, "superadmin uploads QRIS")
    s, info = call("GET", "/payment-info", token=member)
    info = info["data"]
    check(info == {"qris": True, "holder": "Klub Uji", "ewallet_number": "081200000000", "ewallet_names": "GoPay, DANA",
                   "banks": [{"bank": "BCA", "number": "1234567890"}]}, "member reads payment details", str(info))
    s, img = call("GET", "/payment-info/qris", token=member)
    check(s == 200 and img == PNG, "member gets the QRIS image")
    check(call("GET", "/payment-info")[0] == 401, "payment details need sign-in")

    print("3. claim for a held seat, confirmed")
    m = call("POST", "/matches", {"title": f"Bayar {RUN}", "location_name": "GOR", "location_maps_url": "https://maps.app.goo.gl/x",
                                 "starts_at": (dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=1)).isoformat(), "duration_hours": 2, "capacity": 4,
                                 "match_type": "intermediate", "racket_provided": False, "shuttlecock_provided": True, "price_idr": 40000}, token=root)[1]["data"]["id"]
    rid = call("POST", f"/matches/{m}/join-requests", {}, token=member)[1]["data"]["id"]
    check(call("POST", f"/join-requests/{rid}/approve", token=root)[1]["data"]["status"] == "awaiting_payment", "empty wallet: seat held")
    check(call("POST", "/payment-claims", {"amount_idr": 0, "method": "BCA"}, token=member)[0] == 422, "claim needs an amount")
    s, j = call("POST", "/payment-claims", {"amount_idr": 40000, "method": "BCA", "join_request_id": rid, "note": "dari Budi"}, token=member)
    check(s == 201 and j["data"]["status"] == "pending", "member claims the payment")
    claim = j["data"]["id"]
    pending = call("GET", "/payment-claims", token=root)[1]["data"]
    row = next((c for c in pending if c["id"] == claim), None)
    check(row and row["match_title"] == f"Bayar {RUN}" and row["user"]["id"] == member_id and row["note"] == "dari Budi", "admin sees the claim with its match")
    check(any(c["id"] == claim for c in call("GET", "/payment-claims", token=member)[1]["data"]), "member sees own claim")
    notes = call("GET", "/notifications", token=root)[1]["data"]
    check(any(n["kind"] == "payment_claim" for n in notes), "admin is notified")
    check(call("POST", f"/payment-claims/{claim}/confirm", token=member)[0] == 403, "member cannot confirm")
    check(call("POST", f"/payment-claims/{claim}/confirm", token=root)[1]["data"]["status"] == "confirmed", "admin confirms")
    req = next(r for r in call("GET", "/me/join-requests", token=member)[1]["data"] if r["id"] == rid)
    check(req["status"] == "confirmed" and req["payment_method"] == "wallet", "seat confirmed from the credited wallet", str(req))
    check(call("GET", "/wallets/me", token=member)[1]["data"]["balance_idr"] == 0, "credit fully used by the seat")
    check(call("POST", f"/payment-claims/{claim}/confirm", token=root)[0] == 409, "a claim is confirmed once")

    print("4. top-up claim, rejected")
    claim2 = call("POST", "/payment-claims", {"amount_idr": 25000, "method": "QRIS"}, token=member)[1]["data"]["id"]
    check(call("POST", f"/payment-claims/{claim2}/reject", token=root)[1]["data"]["status"] == "rejected", "admin rejects")
    check(call("GET", "/wallets/me", token=member)[1]["data"]["balance_idr"] == 0, "rejected claim adds nothing")
    check(any(n["kind"] == "payment_rejected" for n in call("GET", "/notifications", token=member)[1]["data"]), "member told it was rejected")
    s, j = call("GET", "/finance/summary", token=root)
    check(j["data"]["discrepancy_idr"] == 0, "ledger still balanced")
finally:
    # put the site's real payment settings back
    old = json.loads(saved)
    psql("UPDATE settings SET pay_qris_path = {}, pay_holder = {}, pay_ewallet_number = {}, pay_ewallet_names = {}, pay_banks = '{}'::jsonb".format(
        *("NULL" if old[k] is None else "'" + str(old[k]).replace("'", "''") + "'" for k in ("pay_qris_path", "pay_holder", "pay_ewallet_number", "pay_ewallet_names")),
        json.dumps(old["pay_banks"]).replace("'", "''")))

print(f"\n{passed} passed, {len(failed)} failed")
sys.exit(1 if failed else 0)
