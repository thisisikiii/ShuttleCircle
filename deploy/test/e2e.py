"""End-to-end test against a running stack (compose.yaml + test/compose.test.yaml).

Run from deploy/:  python3 test/e2e.py
Needs in .env: DOMAIN=localhost, MIDTRANS_SERVER_KEY=<any test value>, RATE_LIMIT_PER_MIN=1000.
Uses only the standard library. Time-dependent rules (hold expiry, rewards) are driven by
editing rows through psql and waiting for the 30-second worker tick.
"""
import base64
import datetime as dt
import hashlib
import json
import os
import ssl
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid

DEPLOY = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV = dict(l.strip().split("=", 1) for l in open(os.path.join(DEPLOY, ".env")) if "=" in l and not l.startswith("#"))
BASE = os.environ.get("BASE", "https://localhost")
KEY = ENV["MIDTRANS_SERVER_KEY"]
CTX = ssl._create_unverified_context()  # Caddy's local CA certificate
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


def psql(sql):
    r = subprocess.run(["docker", "compose", "exec", "-T", "db", "psql", "-U", "shuttlecircle", "-tA", "-v", "ON_ERROR_STOP=1", "-c", sql],
                       cwd=DEPLOY, capture_output=True, text=True)
    if r.returncode:
        raise RuntimeError(r.stderr)
    return r.stdout.strip()


def http(method, url, data=None, headers=None):
    req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    try:
        r = urllib.request.urlopen(req, context=CTX)
    except urllib.error.HTTPError as e:
        r = e
    return r.status, r.headers, r.read()


class Actor:
    def __init__(self, name):
        self.name, self.cookies, self.token, self.id = name, {}, None, None

    def call(self, method, path, body=None, raw=None, ctype="application/json"):
        headers = {}
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        if data is not None:
            headers["Content-Type"] = ctype
        if self.token:
            headers["Authorization"] = "Bearer " + self.token
        if self.cookies:
            headers["Cookie"] = "; ".join(f"{k}={v}" for k, v in self.cookies.items())
        status, h, raw_out = http(method, BASE + "/api/v1" + path, data, headers)
        for c in h.get_all("Set-Cookie") or []:
            k, v = c.split(";")[0].split("=", 1)
            if v:
                self.cookies[k] = v
            else:
                self.cookies.pop(k, None)
        try:
            out = json.loads(raw_out) if raw_out else None
        except ValueError:
            out = raw_out
        return status, out

    def data(self, method, path, body=None):
        s, j = self.call(method, path, body)
        assert s < 300, f"{self.name} {method} {path} -> {s} {j}"
        return j["data"]

    def register(self):
        self.email = f"{self.name}-{RUN}@test.id"
        s, j = self.call("POST", "/auth/register", {"email": self.email, "password": "password-123", "full_name": self.name.title()})
        assert s == 200, (s, j)
        self.token = j["data"]["access_token"]
        self.id = self.data("GET", "/me")["id"]
        return self

    def refresh(self):
        s, j = self.call("POST", "/auth/refresh")
        if s == 200:
            self.token = j["data"]["access_token"]
        return s

    def balance(self):
        return self.data("GET", "/wallets/me")["balance_idr"]

    def request(self, match_id):
        return self.call("POST", f"/matches/{match_id}/join-requests", {})

    def my_request(self, req_id):
        return next(r for r in self.data("GET", "/me/join-requests") if r["id"] == req_id)


def code(resp):
    s, j = resp
    return s, (j or {}).get("error", {}).get("code") if isinstance(j, dict) else None


def new_match(actor, **over):
    body = {"title": f"E2E {RUN}", "location_name": "GOR Test", "location_maps_url": "https://maps.app.goo.gl/test",
            "starts_at": (dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=2)).isoformat(), "duration_hours": 2, "capacity": 4,
            "match_type": "intermediate", "racket_provided": False, "shuttlecock_provided": True,
            "court_cost_per_hour_idr": 100000, "price_idr": 50000}
    body.update(over)
    return actor.call("POST", "/matches", body)


def webhook(payment_id, amount, status="settlement", key=None):
    order, sc, gross = f"SC-{payment_id}", "200", f"{amount}.00"
    sig = hashlib.sha512(f"{order}{sc}{gross}{key or KEY}".encode()).hexdigest()
    return Actor("midtrans").call("POST", "/webhooks/midtrans", {"order_id": order, "status_code": sc, "gross_amount": gross,
                                                                "transaction_status": status, "signature_key": sig})


def wait_for(fn, seconds=50):
    end = time.time() + seconds
    while time.time() < end:
        if fn():
            return True
        time.sleep(3)
    return False


def ledger_sum(actor):
    return sum(t["amount_idr"] for t in actor.data("GET", "/wallets/me/transactions?limit=100"))


# ---------------------------------------------------------------------------
print("1. health, web shell, security headers")
s, h, body = http("GET", BASE + "/api/v1/healthz")
health = json.loads(body)
check(s == 200 and health["status"] == "ok", "healthz ok")
check(health["features"] == {"gateway": True, "google": False, "email": False, "whatsapp": False}, "feature flags reflect config", str(health))
s, h, body = http("GET", BASE + "/")
check(s == 200 and "text/html" in h.get("Content-Type", ""), "web app served at /")
check(h.get("X-Frame-Options") == "DENY" and "max-age" in h.get("Strict-Transport-Security", "") and h.get("Content-Security-Policy"), "security headers set")
check(Actor("anon").call("GET", "/me")[0] == 401, "anonymous /me is 401")

print("2. accounts and roles")
root, host, ana, budi, citra = (Actor(n).register() for n in ("root", "host", "ana", "budi", "citra"))
r = subprocess.run(["docker", "compose", "exec", "-T", "api", "shuttlecircle", "create-superadmin", "--email", root.email], cwd=DEPLOY, capture_output=True, text=True)
check(r.returncode == 0, "create-superadmin command", r.stderr)
root.refresh()
check(root.data("GET", "/me")["role"] == "superadmin", "superadmin role active after refresh")
check(ana.call("PATCH", f"/users/{host.id}", {"role": "host"})[0] == 403, "member cannot change roles")
check(root.call("PATCH", f"/users/{host.id}", {"role": "host"})[0] == 204, "superadmin promotes host")
check(code(root.call("PATCH", f"/users/{root.id}", {"role": "member"})) == (409, "SELF_CHANGE"), "superadmin cannot demote self")
host.refresh()
check(code(Actor("dup").call("POST", "/auth/register", {"email": ana.email, "password": "password-123", "full_name": "X"})) == (409, "EMAIL_TAKEN"), "duplicate email rejected")
check(Actor("x").call("POST", "/auth/register", {"email": "bad", "password": "short", "full_name": ""})[0] == 422, "register validation")
check(Actor("x").call("POST", "/auth/login", {"email": ana.email, "password": "wrong-password"})[0] == 401, "wrong password rejected")

print("3. match configuration")
check(new_match(ana)[0] == 403, "member cannot create match")
check(new_match(host, capacity=0)[0] == 422, "capacity 0 rejected")
check(new_match(host, host_id=ana.id)[0] == 403, "host cannot assign another host")
s, j = new_match(host, capacity=2)
check(s == 201 and j["data"]["host_id"] == host.id, "host creates match, becomes host")
m1 = j["data"]["id"]
m_root = new_match(root)[1]["data"]["id"]
check(host.call("PATCH", f"/matches/{m_root}", {"title": "x"})[0] == 403, "host cannot edit another's match")
check(root.call("PATCH", f"/matches/{m_root}", {"host_id": ana.id})[0] == 422, "plain member cannot be made host")
cal = ana.data("GET", "/matches?from=2000-01-01&to=2100-01-01")
mine = next(m for m in cal if m["id"] == m1)
check(mine["status"] == "scheduled" and mine["seats_taken"] == 0 and "court_cost_per_hour_idr" in mine and mine["court_cost_per_hour_idr"] is None, "calendar item; court cost hidden from members")
far = psql("SELECT count(*) FROM matches WHERE starts_at > now() + interval '3 months' OR starts_at < now() - interval '1 month'")
check(all(m["status"] in ("scheduled", "ongoing", "completed", "cancelled") for m in cal), f"calendar clamped (out-of-window rows in db: {far})")

print("4. guest request, approval, conversion, gateway payment")
guest = Actor("guest")
check(guest.call("POST", "/auth/guest", {"nickname": "G"})[0] == 422, "nickname too short rejected")
check(guest.call("POST", "/auth/guest", {"nickname": "Gilang"})[0] == 200 and "sc_guest" in guest.cookies, "guest cookie issued")
check(guest.data("GET", "/me") == {"kind": "guest", "nickname": "Gilang"}, "guest /me")
s, j = guest.request(m1)
check(s == 201 and j["data"]["status"] == "pending" and j["data"]["player"]["kind"] == "guest", "guest request pending")
g_req = j["data"]["id"]
check(code(guest.request(m1)) == (409, "DUPLICATE_REQUEST"), "duplicate request rejected")
check(ana.call("POST", f"/join-requests/{g_req}/approve")[0] == 403, "member cannot approve")
check(any(r["id"] == g_req for r in host.data("GET", "/join-requests?status=pending")), "request appears in host queue")
appr = host.data("POST", f"/join-requests/{g_req}/approve")
check(appr["status"] == "awaiting_payment" and appr["conversion_required"] and appr["hold_expires_at"], "approved guest is held, conversion required")
check(code(host.call("POST", f"/join-requests/{g_req}/approve")) == (409, "ALREADY_PROCESSED"), "second approval is 409")
check(code(guest.call("POST", f"/join-requests/{g_req}/pay")) == (403, "CONVERSION_REQUIRED"), "guest cannot pay (DEC-004)")
guest.name = "gilang"
guest.register()
check("sc_guest" not in guest.cookies, "guest cookie cleared on conversion")
linked = guest.my_request(g_req)
check(linked["player"]["kind"] == "member" and not linked["conversion_required"], "request linked to new account")
pay = guest.data("POST", f"/join-requests/{g_req}/pay")
check(pay["status"] == "awaiting_payment" and pay["payment"]["amount_idr"] == 50000 and pay["payment"]["redirect_url"], "pay returns Snap payment")
again = guest.data("POST", f"/join-requests/{g_req}/pay")
check(again["payment"]["id"] == pay["payment"]["id"], "pending payment is reused")
pid = pay["payment"]["id"]
check(code(webhook(pid, 50000, key="wrong")) == (403, "BAD_SIGNATURE"), "webhook bad signature rejected")
check(code(webhook(pid, 40000)) == (409, "AMOUNT_MISMATCH"), "webhook amount mismatch rejected")
check(webhook(pid, 50000)[0] == 200, "webhook settlement accepted")
done = guest.my_request(g_req)
check(done["status"] == "confirmed" and done["payment_method"] == "gateway", "seat confirmed via gateway")
check(guest.balance() == 0 and sorted(t["amount_idr"] for t in guest.data("GET", "/wallets/me/transactions")) == [-50000, 50000], "gateway money passed through the ledger")
check(webhook(pid, 50000)[0] == 200 and guest.balance() == 0 and len(guest.data("GET", "/wallets/me/transactions")) == 2, "duplicate webhook is idempotent")

print("5. wallet: manual credit and auto-deduct")
check(ana.call("POST", f"/wallets/{ana.id}/credits", {"amount_idr": 100000, "note": "x"})[0] == 403, "member cannot credit")
check(root.call("POST", f"/wallets/{ana.id}/credits", {"amount_idr": 100000})[0] == 422, "credit needs a reason")
check(root.call("POST", f"/wallets/{ana.id}/credits", {"amount_idr": 0, "note": "x"})[0] == 422, "credit needs positive amount")
s, j = root.call("POST", f"/wallets/{ana.id}/credits", {"amount_idr": 100000, "note": "tunai"})
check(s == 201 and j["data"]["balance_idr"] == 100000 and j["data"]["created_by"] == root.id, "manual credit recorded with actor")
a_req = ana.request(m1)[1]["data"]["id"]
appr = host.data("POST", f"/join-requests/{a_req}/approve")
check(appr["status"] == "confirmed" and appr["payment_method"] == "wallet" and ana.balance() == 50000, "approval auto-deducts wallet (DEC-002)")
check(code(root.call("POST", f"/wallets/{ana.id}/adjustments", {"amount_idr": -999999, "note": "x"})) == (409, "INSUFFICIENT_BALANCE"), "balance cannot go negative")
check(code(ana.call("POST", "/donations", {"amount_idr": 999999})) == (409, "INSUFFICIENT_BALANCE"), "donation above balance fails")
check(ana.call("POST", "/donations", {"amount_idr": 10000})[0] == 201 and ana.balance() == 40000, "donation debits wallet")
s, j = ana.call("POST", "/wallets/me/topups", {"amount_idr": 5000})
check(s == 422, "top-up below minimum rejected")
s, j = ana.call("POST", "/wallets/me/topups", {"amount_idr": 20000})
check(s == 201 and ana.balance() == 40000, "top-up start writes no ledger entry")
check(webhook(j["data"]["payment"]["id"], 20000)[0] == 200 and ana.balance() == 60000, "top-up credited by webhook")

print("6. capacity under concurrency")
b_req = budi.request(m1)[1]["data"]["id"]
check(code(host.call("POST", f"/join-requests/{b_req}/approve")) == (409, "MATCH_FULL"), "approval on full match is 409")
m2 = new_match(host, capacity=1)[1]["data"]["id"]
reqs = [budi.request(m2)[1]["data"]["id"], citra.request(m2)[1]["data"]["id"]]
results = []
threads = [threading.Thread(target=lambda r=r: results.append(host.call("POST", f"/join-requests/{r}/approve")[0])) for r in reqs]
[t.start() for t in threads]
[t.join() for t in threads]
check(sorted(results) == [200, 409], "two parallel approvals for the last seat: exactly one wins", str(results))
check(host.data("GET", f"/matches/{m2}")["seats_taken"] == 1, "seats taken equals capacity")
check(host.call("PATCH", f"/matches/{m2}", {"capacity": 0})[0] == 422 and code(host.call("PATCH", f"/matches/{m1}", {"capacity": 1})) == (409, "CAPACITY_BELOW_TAKEN"), "capacity cannot drop below seats taken")
check(code(host.call("PATCH", f"/matches/{m1}", {"price_idr": 1})) == (409, "PRICE_LOCKED"), "price locked once seats are taken")

print("7. manual credit settles a held seat")
# Whoever won the race for the last seat holds it unpaid.
winner, held = (budi, reqs[0]) if budi.my_request(reqs[0])["status"] == "awaiting_payment" else (citra, reqs[1])
root.data("POST", f"/wallets/{winner.id}/credits", {"amount_idr": 50000, "note": "tunai"})
check(winner.my_request(held)["status"] == "confirmed" and winner.balance() == 0, "credit confirms the held seat at once")

print("8. hold expiry, late payment, re-approval (waits for the worker)")
m3 = new_match(host)[1]["data"]["id"]
loser = citra if winner is budi else budi
l_req = loser.request(m3)[1]["data"]["id"]
check(host.data("POST", f"/join-requests/{l_req}/approve")["status"] == "awaiting_payment", "no balance: seat held")
late_pid = loser.data("POST", f"/join-requests/{l_req}/pay")["payment"]["id"]
psql(f"UPDATE join_requests SET hold_expires_at = now() - interval '1 minute' WHERE id = '{l_req}'")
check(code(loser.call("POST", f"/join-requests/{l_req}/pay")) == (409, "HOLD_EXPIRED"), "pay after deadline is 409")
check(wait_for(lambda: loser.my_request(l_req)["status"] == "expired"), "worker expires the hold")
check(host.data("GET", f"/matches/{m3}")["seats_taken"] == 0, "seat freed, nobody promoted (DEC-003)")
check(any(n["kind"] == "hold_expired" for n in loser.data("GET", "/notifications")), "expiry notification written")
before = loser.balance()
check(webhook(late_pid, 50000)[0] == 200 and loser.balance() == before + 50000 and loser.my_request(l_req)["status"] == "expired", "late payment stays in wallet")
check(any(n["kind"] == "late_payment" for n in loser.data("GET", "/notifications")), "late payment notification written")
re = host.data("POST", f"/join-requests/{l_req}/approve")
check(re["status"] == "confirmed" and re["payment_method"] == "wallet" and loser.balance() == before, "expired request re-approved manually, paid from wallet")

print("9. membership")
month = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=2, hours=7)).strftime("%Y-%m-01")
root.data("PATCH", "/settings", {"membership_price_idr": 0})
check(code(budi.call("POST", "/memberships", {"month": month})) == (409, "NOT_FOR_SALE"), "membership unavailable while price unset")
check(ana.call("PATCH", "/settings", {"reward_enabled": False})[0] == 403, "member cannot change settings")
check(root.data("PATCH", "/settings", {"membership_price_idr": 150000})["membership_price_idr"] == 150000, "superadmin sets membership price")
mem = Actor("mira").register()
check(code(mem.call("POST", "/memberships", {"month": month})) == (409, "INSUFFICIENT_BALANCE"), "membership needs balance")
root.data("POST", f"/wallets/{mem.id}/credits", {"amount_idr": 150000, "note": "tunai"})
check(mem.call("POST", "/memberships", {"month": "2020-01-01"})[0] == 422, "membership only for current or next month")
check(mem.call("POST", "/memberships", {"month": month})[0] == 201 and mem.balance() == 0, "membership bought from wallet")
check(code(mem.call("POST", "/memberships", {"month": month})) == (409, "ALREADY_MEMBER"), "one membership per month")
m_req = mem.request(m3)[1]["data"]["id"]
appr = host.data("POST", f"/join-requests/{m_req}/approve")
check(appr["status"] == "confirmed" and appr["payment_method"] == "membership" and mem.balance() == 0, "membership covers the seat")

print("10. reward engine (waits for the worker)")
rita = Actor("rita").register()
psql(f"""DO $$ DECLARE mid uuid; BEGIN FOR k IN 1..5 LOOP
  INSERT INTO matches(host_id, created_by, title, location_name, location_maps_url, starts_at, duration_hours, capacity, match_type, racket_provided, shuttlecock_provided, price_idr)
  VALUES ('{host.id}', '{host.id}', 'Past {RUN} ' || k, 'GOR', 'https://maps.app.goo.gl/x', now() - make_interval(days => k, hours => 3), 1, 8, 'intermediate', false, false, 0) RETURNING id INTO mid;
  INSERT INTO join_requests(match_id, user_id, status, payment_method) VALUES (mid, '{rita.id}', 'confirmed', 'wallet');
END LOOP; END $$""")
check(wait_for(lambda: len(rita.data("GET", "/me")["rewards"]) == 1), "fifth attended match in 2 months earns one reward")
check(any(n["kind"] == "reward_earned" for n in rita.data("GET", "/notifications")), "reward notification written")
root.data("POST", f"/wallets/{rita.id}/credits", {"amount_idr": 50000, "note": "tunai"})
r_req = rita.request(m3)[1]["data"]["id"]
appr = host.data("POST", f"/join-requests/{r_req}/approve")
check(appr["status"] == "confirmed" and appr["payment_method"] == "reward" and rita.balance() == 50000, "reward used before wallet, no charge")
check(rita.data("GET", "/me")["rewards"] == [], "reward is spent")
psql(f"""DO $$ DECLARE mid uuid; BEGIN
  INSERT INTO matches(host_id, created_by, title, location_name, location_maps_url, starts_at, duration_hours, capacity, match_type, racket_provided, shuttlecock_provided, price_idr)
  VALUES ('{host.id}', '{host.id}', 'Past {RUN} 6', 'GOR', 'https://maps.app.goo.gl/x', now() - interval '2 hours', 1, 8, 'intermediate', false, false, 0) RETURNING id INTO mid;
  INSERT INTO join_requests(match_id, user_id, status, payment_method) VALUES (mid, '{rita.id}', 'confirmed', 'wallet');
END $$""")
check(wait_for(lambda: psql(f"SELECT count(*) FROM matches WHERE title = 'Past {RUN} 6' AND rewards_processed_at IS NOT NULL") == "1"), "worker processed the sixth match")
check(psql(f"SELECT count(*) FROM rewards WHERE user_id = '{rita.id}'") == "1", "sixth match does not earn a second reward")

print("11. history, games, media")
hist = rita.data("GET", "/history")
check(len(hist) == 6 and all(m["status"] == "completed" for m in hist), "member history lists attended matches only")
check(ana.data("GET", "/history") == [], "no attended matches, empty history")
check(ana.call("GET", "/history?scope=all")[0] == 403 and len(root.data("GET", "/history?scope=all")) >= 6, "all-matches history is admin only")
past = hist[0]["id"]
jr = rita.data("GET", f"/matches/{past}")["roster"][0]["join_request_id"]
check(rita.call("PUT", f"/matches/{past}/games", [{"join_request_id": jr, "games_played": 3}])[0] == 403, "member cannot enter games")
check(host.call("PUT", f"/matches/{past}/games", [{"join_request_id": jr, "games_played": 3}])[0] == 204, "host enters games played")
check(rita.data("GET", "/history")[0]["players"][0]["games_played"] == 3, "games played shown in history")
check(code(host.call("PUT", f"/matches/{m3}/games", [])) == (409, "MATCH_NOT_STARTED"), "games only after match start")
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==")


def multipart(content, filename):
    b = "e2eboundary"
    body = f'--{b}\r\nContent-Disposition: form-data; name="file"; filename="{filename}"\r\nContent-Type: application/octet-stream\r\n\r\n'.encode() + content + f"\r\n--{b}--\r\n".encode()
    return body, f"multipart/form-data; boundary={b}"


raw, ctype = multipart(PNG, "a.png")
check(rita.call("POST", f"/matches/{past}/media", raw=raw, ctype=ctype)[0] == 403, "member cannot upload media")
s, j = host.call("POST", f"/matches/{past}/media", raw=raw, ctype=ctype)
check(s == 201 and j["data"]["kind"] == "photo", "host uploads a photo")
media_id = j["data"]["id"]
raw2, ctype2 = multipart(b"#!/bin/sh\necho not an image\n", "evil.png")
check(host.call("POST", f"/matches/{past}/media", raw=raw2, ctype=ctype2)[0] == 422, "file type checked from content, not name")
s, out = rita.call("GET", f"/media/{media_id}/file")
check(s == 200 and out == PNG, "attendee downloads the file intact")
check(ana.call("GET", f"/media/{media_id}/file")[0] == 403 and Actor("anon").call("GET", f"/media/{media_id}/file")[0] == 401, "media is private to attendees")
check(host.call("DELETE", f"/media/{media_id}")[0] == 204 and rita.data("GET", f"/matches/{past}/media") == [], "host deletes media")

print("12. match cancellation and refund")
check(host.call("POST", f"/matches/{m3}/cancel")[0] == 403, "only superadmin cancels a match")
before = {a.name: a.balance() for a in (loser, mem, rita)}
out = root.data("POST", f"/matches/{m3}/cancel")
check(out["status"] == "cancelled" and out["refunded"] == 1, "match cancelled, one paid seat refunded")
check(loser.balance() == before[loser.name] + 50000, "paid fee refunded to wallet (DEC-016)")
check(mem.balance() == before["mira"] and rita.balance() == before["rita"], "membership and reward seats refund nothing")
check(len(rita.data("GET", "/me")["rewards"]) == 1, "used reward restored")
check(all(a.my_request(r)["status"] == "cancelled" for a, r in ((loser, l_req), (mem, m_req), (rita, r_req))), "requests cancelled")
check(any(n["kind"] == "match_cancelled" for n in rita.data("GET", "/notifications")), "cancellation notification written")
check(code(rita.request(m3)) == (409, "MATCH_NOT_OPEN"), "cancelled match takes no requests")
check(next(m for m in ana.data("GET", "/matches") if m["id"] == m3)["status"] == "cancelled", "calendar shows cancelled")

print("13. finance, expenses, users, notifications")
fin0 = root.data("GET", "/finance/summary")
check(ana.call("GET", "/finance/summary")[0] == 403, "finance is admin only")
check(host.call("POST", "/expenses", {"category": "shuttlecock", "amount_idr": 120000, "spent_on": dt.date.today().isoformat()})[0] == 403, "expense entry is superadmin only")
s, j = root.call("POST", "/expenses", {"category": "shuttlecock", "amount_idr": 120000, "spent_on": dt.date.today().isoformat(), "note": "1 slop"})
fin1 = root.data("GET", "/finance/summary")
check(s == 201 and fin1["expenses"]["shuttlecock"] == fin0["expenses"]["shuttlecock"] + 120000, "expense appears in summary")
root.data("POST", f"/wallets/{ana.id}/credits", {"amount_idr": 7000, "note": "tunai"})
fin2 = root.data("GET", "/finance/summary")
check(fin2["cash_in_idr"] == fin1["cash_in_idr"] + 7000 and fin2["member_balance_idr"] == fin1["member_balance_idr"] + 7000, "manual credit counted as cash in")
db_fee = int(psql("SELECT coalesce(-sum(amount_idr), 0) FROM wallet_txns WHERE txn_type IN ('match_payment','refund') AND created_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Jakarta') AT TIME ZONE 'Asia/Jakarta'"))
check(fin2["fee_income_idr"] == db_fee and fin2["donation_idr"] >= 10000 and fin2["membership_income_idr"] >= 150000, "fee, donation and membership income reported")
check(root.call("DELETE", f"/expenses/{j['data']['id']}")[0] == 204, "expense deleted")
found = root.data("GET", f"/users?q={ana.email}")
check(len(found) == 1 and found[0]["wallet_balance_idr"] == ana.balance(), "user search with balance")
check(ana.data("GET", "/me")["unread_notifications"] > 0, "unread count")
check(ana.call("POST", "/notifications/read", {"all": True})[0] == 204 and ana.data("GET", "/me")["unread_notifications"] == 0, "mark all read")
s, j = ana.call("GET", "/wallets/me/transactions?limit=2")
check(len(j["data"]) == 2 and j["meta"]["next_cursor"], "ledger pagination returns a cursor")
s, j2 = ana.call("GET", "/wallets/me/transactions?limit=2&cursor=" + j["meta"]["next_cursor"])  # '+' left unencoded on purpose
check(s == 200 and j2["data"] and j2["data"][0]["id"] not in [t["id"] for t in j["data"]], "cursor returns the next page")

print("14. sessions")
old = dict(ana.cookies)
check(ana.refresh() == 200 and ana.cookies["sc_refresh"] != old["sc_refresh"], "refresh rotates the token")
stale = Actor("stale")
stale.cookies = dict(old)
check(stale.refresh() == 401 and ana.refresh() == 200, "rotated token rejected; a race within 30 s does not end the session")
old = dict(ana.cookies)
ana.refresh()
psql(f"UPDATE refresh_tokens SET revoked_at = now() - interval '1 minute' WHERE user_id = '{ana.id}' AND revoked_at IS NOT NULL")
stale.cookies = dict(old)
check(stale.refresh() == 401 and ana.refresh() == 401, "replay of an old token ends every session of that user")
check(Actor("x").call("POST", "/auth/login", {"email": ana.email, "password": "password-123"})[0] == 200, "user can sign in again")
check(root.call("PATCH", f"/users/{budi.id}", {"status": "suspended"})[0] == 204 and budi.refresh() == 401, "suspended user cannot refresh")
check(code(Actor("x").call("POST", "/auth/login", {"email": budi.email, "password": "password-123"})) == (401, "SUSPENDED"), "suspended user cannot sign in")
check(root.call("POST", "/auth/logout")[0] == 204 and root.refresh() == 401, "logout revokes the refresh token")

print("15. invariants over the whole database")
check(psql("SELECT count(*) FROM wallets w WHERE balance_idr <> (SELECT coalesce(sum(amount_idr), 0) FROM wallet_txns t WHERE t.user_id = w.user_id)") == "0", "every balance equals its ledger sum")
check(psql("SELECT count(*) FROM matches m WHERE capacity < (SELECT count(*) FROM join_requests j WHERE j.match_id = m.id AND j.status IN ('awaiting_payment','confirmed'))") == "0", "no match over capacity")
check(psql("SELECT count(*) FROM wallets WHERE balance_idr < 0") == "0", "no negative balance")
check(psql("SELECT count(*) FROM join_requests WHERE status = 'awaiting_payment' AND hold_expires_at IS NULL") == "0", "every held seat has a deadline")

print(f"\n{passed} passed, {len(failed)} failed")
for f in failed:
    print("  FAILED:", f)
sys.exit(1 if failed else 0)
