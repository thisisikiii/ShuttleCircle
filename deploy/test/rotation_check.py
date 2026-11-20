"""Checks court rotation (FR-19, AC-F11-*) on the test copy. Run from deploy/: BASE=https://localhost:8443 python3 test/rotation_check.py"""
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


class Actor:
    def __init__(self, name):
        self.name, self.token = name, None

    def call(self, method, path, body=None):
        headers = {"Content-Type": "application/json"} if body is not None else {}
        if self.token:
            headers["Authorization"] = "Bearer " + self.token
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(BASE + "/api/v1" + path, data=data, method=method, headers=headers)
        try:
            r = urllib.request.urlopen(req, context=CTX)
        except urllib.error.HTTPError as e:
            r = e
        raw = r.read()
        return r.status, (json.loads(raw) if raw else None)

    def data(self, method, path, body=None):
        s, j = self.call(method, path, body)
        assert s < 300, f"{self.name} {method} {path} -> {s} {j}"
        return j["data"] if j else None

    def register(self):
        self.email = f"{self.name}-{RUN}@test.id"
        s, j = self.call("POST", "/auth/register", {"email": self.email, "password": "password-123", "full_name": self.name})
        assert s == 200, (s, j)
        self.token = j["data"]["access_token"]
        self.id = self.data("GET", "/me")["id"]
        return self


def err(resp):
    s, j = resp
    return s, (j or {}).get("error", {}).get("code")


print("1. setup: host, 10 confirmed players, one outsider")
root = Actor("Root").register()
subprocess.run(["docker", "compose", "exec", "-T", "api", "shuttlecircle", "create-superadmin", "--email", root.email], cwd=DEPLOY, check=True, capture_output=True)
# sign in again so the token carries the new role
s, j = root.call("POST", "/auth/login", {"email": root.email, "password": "password-123"})
root.token = j["data"]["access_token"]
host = Actor("Host").register()
root.data("PATCH", f"/users/{host.id}", {"role": "host"})
s, j = host.call("POST", "/auth/login", {"email": host.email, "password": "password-123"})
host.token = j["data"]["access_token"]
names = ["Andi", "Budi", "Citra", "Dewi", "Eko", "Fajar", "Gita", "Hadi", "Indra", "Joko", "Kiki"]
players = [Actor(n).register() for n in names]
outsider = Actor("Luar").register()
m = host.data("POST", "/matches", {
    "title": f"Rotasi {RUN}", "location_name": "GOR Test", "location_maps_url": "https://maps.app.goo.gl/test",
    "starts_at": (dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=1)).isoformat(), "duration_hours": 3, "capacity": 12,
    "match_type": "intermediate", "racket_provided": False, "shuttlecock_provided": True, "price_idr": 0})["id"]
jr = {}
for p in players[:10]:
    rid = p.data("POST", f"/matches/{m}/join-requests", {})["id"]
    check(host.data("POST", f"/join-requests/{rid}/approve")["status"] == "confirmed", f"{p.name} confirmed")
    jr[p.name] = rid
R = f"/matches/{m}/rotation"
name_of = {v: k for k, v in jr.items()}


def board(actor=host):
    return actor.data("GET", R)


def teams(g):
    return [name_of.get(i, "?") for i in g["team_a"]], [name_of.get(i, "?") for i in g["team_b"]]


def game(b, court, status):
    return next((g for g in b["games"] if g["court"] == court and g["status"] == status), None)


def player(b, name):
    return next(p for p in b["players"] if p["name"] == name)


print("2. board visibility and access (AC-F11-01, AC-F11-11)")
b = board(outsider)
check(len(b["players"]) == 10 and all(p["state"] == "absent" for p in b["players"]), "member sees the confirmed roster, all not arrived")
check(len(b["courts"]) == 2 and b["singles"] is False, "defaults: 2 courts, doubles")
check(err(players[0].call("POST", f"{R}/courts/1/next")) == (403, "FORBIDDEN"), "plain member cannot change the board")
check(err(outsider.call("PATCH", R, {"courts": 3})) == (403, "FORBIDDEN"), "outsider cannot change the board")
check(err(host.call("PATCH", R, {"courts": 0}))[0] == 422, "0 courts rejected")

print("3. check-in and first picks (AC-F11-02..04)")
for n in names[:10]:
    host.data("POST", f"{R}/players", {"join_request_ids": [jr[n]], "state": "waiting"})
b = board()
check([p["name"] for p in sorted(b["players"], key=lambda p: p["queue_position"])] == names[:10], "queue follows arrival order at 0 games")
b = host.data("POST", f"{R}/courts/1/next")
check(teams(game(b, 1, "next")) == (["Andi", "Dewi"], ["Budi", "Citra"]), "court 1: 1st+4th vs 2nd+3rd")
b = host.data("POST", f"{R}/courts/2/next")
check(teams(game(b, 2, "next")) == (["Eko", "Hadi"], ["Fajar", "Gita"]), "court 2 skips players already in a turn")
check(player(b, "Andi")["queued"] and player(b, "Andi")["queue_position"] is None, "queued player is out of the free queue")
g1 = game(b, 1, "next")["id"]
b = host.data("POST", f"{R}/courts/1/next")
check(teams(game(b, 1, "next")) == (["Andi", "Dewi"], ["Budi", "Citra"]) and game(b, 1, "next")["id"] != g1, "pick again with an unchanged queue gives the same players")
g1, g2 = game(b, 1, "next")["id"], game(b, 2, "next")["id"]
host.data("POST", f"{R}/games/{g1}/start")
b = host.data("POST", f"{R}/games/{g2}/start")
check(player(b, "Andi")["state"] == "playing" and game(b, 1, "playing")["started_at"], "started game shows players as playing")
check(err(host.call("POST", f"{R}/courts/1/next")) == (409, "NOT_ENOUGH_PLAYERS"), "only 2 waiting: not enough for doubles")

print("4. rest, leave, on-court rules (AC-F11-10)")
check(err(host.call("POST", f"{R}/players", {"join_request_ids": [jr["Andi"]], "state": "resting"})) == (409, "PLAYER_ON_COURT"), "player on court cannot rest")
b = host.data("POST", f"{R}/players", {"join_request_ids": [jr["Joko"]], "state": "resting"})
check(player(b, "Joko")["state"] == "resting" and player(b, "Joko")["queue_position"] is None, "resting player leaves the queue")
b = host.data("POST", f"{R}/players", {"join_request_ids": [jr["Joko"]], "state": "waiting"})
check(player(b, "Joko")["state"] == "waiting", "resting player comes back")

print("5. finish, score, games_played (AC-F11-09)")
check(err(host.call("PATCH", f"{R}/games/{g1}", {"score_a": 1, "score_b": 2})) == (409, "GAME_NOT_DONE"), "score of a running game rejected")
b = host.data("POST", f"{R}/games/{g1}/finish", {"score_a": 21, "score_b": 15})
done = next(g for g in b["games"] if g["id"] == g1)
check(done["status"] == "done" and (done["score_a"], done["score_b"]) == (21, 15), "finished with score")
check([player(b, n)["games"] for n in ("Andi", "Budi", "Citra", "Dewi")] == [1, 1, 1, 1], "each player got one game")
roster = {r["name"]: r["games_played"] for r in host.data("GET", f"/matches/{m}")["roster"]}
check(roster["Andi"] == 1 and roster["Eko"] is None, "games_played on the roster follows the rotation")
b = host.data("POST", f"{R}/courts/1/next")
check(teams(game(b, 1, "next")) == (["Indra", "Budi"], ["Joko", "Andi"]), "fewest games first, then arrival: Indra, Joko, Andi, Budi")
b = host.data("PATCH", f"{R}/games/{g1}", {"score_a": 21, "score_b": 19})
check(next(g for g in b["games"] if g["id"] == g1)["score_b"] == 19, "score edited later")

print("6. late arrival does not jump the queue (AC-F11-02)")
rid = players[10].data("POST", f"/matches/{m}/join-requests", {})["id"]
host.data("POST", f"/join-requests/{rid}/approve")
name_of[rid] = "Kiki"
host.data("DELETE", f"{R}/games/{game(b, 1, 'next')['id']}")
b = host.data("POST", f"{R}/players", {"join_request_ids": [rid], "state": "waiting"})
check(player(b, "Kiki")["effective_games"] == 0, "late arrival counted at the current minimum (0: court 2 still on its first game)")
order = [p["name"] for p in sorted((p for p in b["players"] if p["queue_position"]), key=lambda p: p["queue_position"])]
check(order[:3] == ["Indra", "Joko", "Kiki"], "late arrival queues behind those who waited longer", str(order))

print("7. court modes and profiles (AC-F11-05, AC-F11-06)")
for n, g, lv in [("Andi", "M", 3), ("Budi", "M", 1), ("Citra", "F", 2), ("Dewi", "F", 1), ("Indra", "M", 2), ("Joko", "M", 1), ("Kiki", "F", 3)]:
    host.data("PATCH", f"{R}/players/{jr.get(n, rid)}", {"gender": g, "level": lv})
b = host.data("PATCH", f"{R}/courts/1", {"gender_mode": "mixed"})
check(b["courts"][0]["gender_mode"] == "mixed", "court 1 set to mixed")
b = host.data("POST", f"{R}/courts/1/next")
a, bb = game(b, 1, "next")["team_a"], game(b, 1, "next")["team_b"]
gender = {p["join_request_id"]: p["gender"] for p in b["players"]}
check(sorted(gender[i] for i in a) == ["F", "M"] and sorted(gender[i] for i in bb) == ["F", "M"], "mixed: one man and one woman per team", str(teams(game(b, 1, "next"))))
check(err(host.call("PATCH", f"{R}/courts/1", {"level_mode": "loud"}))[0] == 422, "unknown level mode rejected")
check(err(host.call("PATCH", R, {"courts": 1})) == (409, "COURT_BUSY"), "cannot remove a court in use")
check(err(host.call("PATCH", R, {"singles": True})) == (409, "COURT_BUSY"), "cannot change format with open turns")
check(err(host.call("POST", f"{R}/courts/2/next", {"team_a": [jr["Andi"]], "team_b": [jr["Budi"]]}))[0] == 422, "manual pick needs full teams")
check(err(host.call("POST", f"{R}/courts/2/next", {"team_a": [jr["Eko"], jr["Budi"]], "team_b": [jr["Citra"], jr["Dewi"]]}))[0] == 422, "manual pick rejects a player on court")

print("8. live scoreboard and match point (AC-F11-13)")
P = f"{R}/games/{g2}/point"
check(err(players[0].call("POST", P, {"team": "a", "delta": 1})) == (403, "FORBIDDEN"), "member cannot score")
check(err(host.call("POST", P, {"team": "c", "delta": 1}))[0] == 422, "unknown team rejected")
nxt = game(board(), 1, "next")["id"]
check(err(host.call("POST", f"{R}/games/{nxt}/point", {"team": "a", "delta": 1})) == (409, "GAME_NOT_PLAYING"), "no live score before the game starts")
for _ in range(20):
    host.data("POST", P, {"team": "a", "delta": 1})
for _ in range(15):
    b = host.data("POST", P, {"team": "b", "delta": 1})
g = next(x for x in b["games"] if x["id"] == g2)
check((g["score_a"], g["score_b"], g["game_point"], g["winner"]) == (20, 15, ["a"], None), "20-15: match point team A", str(g))
b = host.data("POST", P, {"team": "a", "delta": 1})
g = next(x for x in b["games"] if x["id"] == g2)
check(g["winner"] == "a" and g["game_point"] == [], "21-15: team A wins")
check(err(host.call("POST", P, {"team": "b", "delta": 1})) == (409, "GAME_DECIDED"), "no points after the game is won")
b = host.data("POST", P, {"team": "a", "delta": -1})
check(next(x for x in b["games"] if x["id"] == g2)["score_a"] == 20, "undo last point")
host.data("POST", P, {"team": "a", "delta": 1})
b = host.data("POST", f"{R}/games/{g2}/finish")
g = next(x for x in b["games"] if x["id"] == g2)
check((g["status"], g["score_a"], g["score_b"], g["winner"]) == ("done", 21, 15, "a"), "finish keeps the live score")

print("9. leaderboard (AC-F11-14)")
lb = b["leaderboard"]
check([r["name"] for r in lb] == ["Eko", "Hadi", "Andi", "Dewi", "Budi", "Citra", "Fajar", "Gita"], "ranked by wins, then point difference", str([r["name"] for r in lb]))
eko = lb[0]
check((eko["rank"], eko["games"], eko["wins"], eko["losses"], eko["points_for"], eko["points_against"], eko["point_diff"]) == (1, 1, 1, 0, 21, 15, 6), "row totals", str(eko))
check(next(r for r in lb if r["name"] == "Citra")["point_diff"] == -2, "loser gets a negative difference")
check(board(outsider)["leaderboard"] == lb, "members see the same leaderboard")

print("10. cancelled match is closed")
root.data("POST", f"/matches/{m}/cancel")
check(err(host.call("POST", f"{R}/courts/2/next")) == (409, "MATCH_NOT_OPEN"), "no changes after cancellation")

print(f"\n{passed} passed, {len(failed)} failed")
sys.exit(1 if failed else 0)
