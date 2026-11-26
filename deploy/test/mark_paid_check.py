"""Checks that an admin can mark a held or expired seat as paid (cash), for a member and a guest.
Safe on dev: it creates @test.id accounts and one match, and changes no settings.
Run from deploy/: BASE=http://localhost:8091 python3 test/mark_paid_check.py   (add -p <project> via COMPOSE_PROJECT_NAME)"""
import datetime as dt
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
import uuid

DEPLOY = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = os.environ.get("BASE", "http://localhost:8091")
RUN = uuid.uuid4().hex[:6]
passed, failed = 0, []


def check(cond, name, detail=""):
    global passed
    if cond:
        passed += 1
        print(f"  ok   {name}")
    else:
        failed.append(name)
        print(f"  FAIL {name} {detail}")


def call(method, path, body=None, token=None, cookie=None):
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json"} if data is not None else {}
    if token:
        headers["Authorization"] = "Bearer " + token
    if cookie:
        headers["Cookie"] = cookie
    req = urllib.request.Request(BASE + "/api/v1" + path, data, headers, method=method)
    try:
        r = urllib.request.urlopen(req)
    except urllib.error.HTTPError as e:
        r = e
    out = r.read()
    return r.status, (json.loads(out) if out else None), r.headers


def register(name):
    email = f"{name.lower()}-{RUN}@test.id"
    s, j, _ = call("POST", "/auth/register", {"email": email, "password": "password-123", "full_name": name})
    assert s == 200, (s, j)
    return email, j["data"]["access_token"]


def psql(sql):
    return subprocess.run(["docker", "compose", "exec", "-T", "db", "psql", "-U", "shuttlecircle", "-tAc", sql], cwd=DEPLOY, check=True, capture_output=True, text=True).stdout.strip()


print("1. setup")
root_email, _ = register("Bendahara")
subprocess.run(["docker", "compose", "exec", "-T", "api", "shuttlecircle", "create-superadmin", "--email", root_email], cwd=DEPLOY, check=True, capture_output=True)
root = call("POST", "/auth/login", {"email": root_email, "password": "password-123"})[1]["data"]["access_token"]
host_email, host = register("Tuanrumah")
psql(f"UPDATE users SET role = 'host' WHERE email = '{host_email}'")
host = call("POST", "/auth/login", {"email": host_email, "password": "password-123"})[1]["data"]["access_token"]
_, member = register("Tunai")
before = call("GET", "/finance/summary", token=root)[1]["data"]
m = call("POST", "/matches", {"title": f"Tunai {RUN}", "location_name": "GOR", "location_maps_url": "https://maps.app.goo.gl/x",
                             "starts_at": (dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=1)).isoformat(), "duration_hours": 2, "capacity": 2,
                             "match_type": "intermediate", "racket_provided": False, "shuttlecock_provided": True, "price_idr": 40000}, token=root)[1]["data"]["id"]

print("2. member with an empty wallet: held seat marked paid")
rid = call("POST", f"/matches/{m}/join-requests", {}, token=member)[1]["data"]["id"]
check(call("POST", f"/join-requests/{rid}/approve", token=root)[1]["data"]["status"] == "awaiting_payment", "seat held")
check(call("POST", f"/join-requests/{rid}/mark-paid", token=member)[0] == 403, "member cannot mark paid")
check(call("POST", f"/join-requests/{rid}/mark-paid", token=host)[0] == 403, "host cannot mark paid")
s, j, _ = call("POST", f"/join-requests/{rid}/mark-paid", token=root)
check(s == 200 and j["data"]["status"] == "confirmed" and j["data"]["payment_method"] == "cash", "admin marks paid", str(j))
check(call("GET", "/wallets/me", token=member)[1]["data"]["balance_idr"] == 0, "wallet untouched")
check(any(n["kind"] == "payment_confirmed" for n in call("GET", "/notifications", token=member)[1]["data"]), "member notified")
check(call("POST", f"/join-requests/{rid}/mark-paid", token=root)[0] == 409, "marked once only")

print("3. guest: expired hold marked paid")
s, _, h = call("POST", "/auth/guest", {"nickname": "Abigail"})
cookie = "; ".join(c.split(";")[0] for c in h.get_all("Set-Cookie") or [])
s, j, _ = call("POST", f"/matches/{m}/join-requests", {}, cookie=cookie)
assert s == 201, (s, j)
gid = j["data"]["id"]
call("POST", f"/join-requests/{gid}/approve", token=root)
psql(f"UPDATE join_requests SET status = 'expired', hold_expires_at = NULL WHERE id = '{gid}'")
s, j, _ = call("POST", f"/join-requests/{gid}/mark-paid", token=root)
check(s == 200 and j["data"]["status"] == "confirmed" and j["data"]["player"]["kind"] == "guest", "expired guest seat marked paid", str(j))

print("4. a full match refuses an expired seat")
_, late = register("Telat")
lid = call("POST", f"/matches/{m}/join-requests", {}, token=late)[1]["data"]["id"]
psql(f"UPDATE join_requests SET status = 'expired' WHERE id = '{lid}'")
s, j, _ = call("POST", f"/join-requests/{lid}/mark-paid", token=root)
check(s == 409 and j["error"]["code"] == "MATCH_FULL", "capacity 2 already taken", str(j))

print("5. finance")
after = call("GET", "/finance/summary", token=root)[1]["data"]
check(after["cash_in_idr"] - before["cash_in_idr"] == 80000, "cash in +80.000", f'{before["cash_in_idr"]} -> {after["cash_in_idr"]}')
check(after["fee_income_idr"] - before["fee_income_idr"] == 80000, "match fees +80.000")
check(after["discrepancy_idr"] == 0, "ledger still balanced")

print(f"\n{passed} passed, {len(failed)} failed")
sys.exit(1 if failed else 0)
