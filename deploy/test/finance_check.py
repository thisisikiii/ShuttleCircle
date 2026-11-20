"""Checks the finance dashboard endpoints (summary discrepancy, player metrics, Excel report).
Run from deploy/ of a test or sandbox stack: BASE=https://localhost:8443 python3 test/finance_check.py"""
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


def check(cond, name, detail=""):
    global passed
    if cond:
        passed += 1
        print(f"  ok   {name}")
    else:
        failed.append(name)
        print(f"  FAIL {name} {detail}")


def call(method, path, body=None, token=None, raw=False):
    headers = {"Content-Type": "application/json"} if body is not None else {}
    if token:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(BASE + "/api/v1" + path, json.dumps(body).encode() if body is not None else None, headers, method=method)
    try:
        r = urllib.request.urlopen(req, context=CTX)
    except urllib.error.HTTPError as e:
        r = e
    data = r.read()
    return r.status, r.headers, (data if raw else (json.loads(data) if data else None))


def register(name):
    email = f"{name.lower()}-{RUN}@test.id"
    s, _, j = call("POST", "/auth/register", {"email": email, "password": "password-123", "full_name": name})
    assert s == 200, (s, j)
    return email, j["data"]["access_token"]


def login(email):
    return call("POST", "/auth/login", {"email": email, "password": "password-123"})[2]["data"]["access_token"]


print("1. setup")
root_email, _ = register("Bendahara")
subprocess.run(["docker", "compose", "exec", "-T", "api", "shuttlecircle", "create-superadmin", "--email", root_email], cwd=DEPLOY, check=True, capture_output=True)
root = login(root_email)
_, member = register("Anggota")
member_id = call("GET", "/me", token=member)[2]["data"]["id"]

print("2. access")
check(call("GET", "/finance/players", token=member)[0] == 403, "member cannot read player metrics")
check(call("GET", "/finance/report.xlsx", token=member)[0] == 403, "member cannot download the report")

print("3. summary and discrepancy")
today = dt.date.today().isoformat()
before = call("GET", f"/finance/summary?from={today}&to={today}", token=root)[2]["data"]
check(before["discrepancy_idr"] == 0, "ledger matches wallet balances", str(before))
check(call("POST", f"/wallets/{member_id}/credits", {"amount_idr": 100000, "note": "tunai"}, token=root)[0] == 201, "manual credit")
check(call("POST", "/expenses", {"category": "shuttlecock", "amount_idr": 20000, "spent_on": today, "note": "1 slop"}, token=root)[0] == 201, "expense added")
after = call("GET", f"/finance/summary?from={today}&to={today}", token=root)[2]["data"]
check(after["cash_in_idr"] - before["cash_in_idr"] == 100000 and after["expenses"]["shuttlecock"] - before["expenses"]["shuttlecock"] == 20000, "summary moves with the entries")
check(after["discrepancy_idr"] == 0 and after["member_balance_idr"] - before["member_balance_idr"] == 100000, "discrepancy still 0, balance up")

print("4. player metrics")
start = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(hours=1)).isoformat()
m = call("POST", "/matches", {"title": f"Metrik {RUN}", "location_name": "GOR", "location_maps_url": "https://maps.app.goo.gl/x", "starts_at": start,
                              "duration_hours": 2, "capacity": 8, "match_type": "intermediate", "racket_provided": False,
                              "shuttlecock_provided": True, "price_idr": 0}, token=root)[2]["data"]["id"]
before_p = call("GET", "/finance/players", token=root)[2]["data"]
rid = call("POST", f"/matches/{m}/join-requests", {}, token=member)[2]["data"]["id"]
call("POST", f"/join-requests/{rid}/approve", token=root)
p = call("GET", "/finance/players", token=root)[2]["data"]
check(len(p["weeks"]) == 12 and len(p["months"]) == 12, "12 weeks and 12 months")
check(p["weeks"][-1]["seats"] - before_p["weeks"][-1]["seats"] in (1, 0) and p["months"][-1]["seats"] - before_p["months"][-1]["seats"] == 1,
      "confirmed seat counted in the current month", str(p["months"][-1]))
check(p["months"][-1]["new_members"] >= 2, "new members counted")

print("5. Excel report")
s, h, body = call("GET", f"/finance/report.xlsx?from={today}&to={today}", token=root, raw=True)
check(s == 200 and h.get("Content-Type", "").startswith("application/vnd.openxmlformats"), "xlsx content type")
check(body[:2] == b"PK" and len(body) > 3000, "xlsx is a zip workbook", f"{len(body)} bytes")
check(f"shuttlecircle-laporan-{today}-{today}.xlsx" in h.get("Content-Disposition", ""), "file name carries the range")

print(f"\n{passed} passed, {len(failed)} failed")
sys.exit(1 if failed else 0)
