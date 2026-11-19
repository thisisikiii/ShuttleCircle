# API.md: ShuttleCircle

Base path `/api/v1`. JSON over HTTPS, same origin as the web app (Caddy routes `/api/*` to the backend). Timestamps are UTC ISO 8601. Money is integer rupiah. State names follow FEATURES.md §2.

## 1. Authentication & Authorization

| Property | Value |
|:---|:---|
| Access token | JWT, HS256, 15 min; claims `sub` (user id), `role`, `exp`. Sent as `Authorization: Bearer <token>`. Held in browser memory only |
| Refresh token | Opaque random 32 bytes, 7 days, rotated on every use, stored hashed. Cookie `sc_refresh`: `HttpOnly; Secure; SameSite=Lax; Path=/api/v1/auth` |
| Guest session | Cookie `sc_guest`: HMAC-signed `{sid, nickname}`, `HttpOnly; Secure; SameSite=Lax; Max-Age=30d` (DEC-008) |
| Passwords | Argon2id, minimum 8 characters |
| Google sign-in | OAuth2 authorization code with PKCE; `state` kept in a short-lived signed cookie and checked on callback |

**Identity of a request:** a valid bearer token makes the caller a member (of its role). Otherwise a valid `sc_guest` cookie makes the caller a guest. Otherwise the caller is anonymous.

**CSRF:** state-changing endpoints need the bearer header, which a cross-site page cannot set. The cookie-only endpoints (`/auth/refresh`, `/auth/logout`, `/auth/guest`) are `POST` and protected by `SameSite=Lax`.

**Roles** (FR-07) are checked per route. "Approver" below means the match host, an admin or a superadmin. "Admin" includes superadmin.

**Rate limits** (per IP): auth endpoints 10/min; join-request creation 10/min; payment creation 10/min. Exceeding returns `429`.

## 2. Response format

Success: `{ "data": <object|array>, "meta": { ... } }`.
Error: `{ "error": { "code": "STRING_CODE", "message": "...", "fields": { "name": "reason" } } }`.
Lists that can grow (ledger, notifications, users, history, request queue) use cursor pagination: `?cursor=&limit=` (default 50, max 100) and `meta: { "next_cursor": string|null }`. The calendar is not paginated.

| Status | Use |
|:---|:---|
| 400 | Malformed request |
| 401 | No or invalid session |
| 403 | Role or ownership forbids it |
| 404 | Not found |
| 409 | State conflict (already processed, match full, duplicate, match started) |
| 422 | Validation failed (`fields` filled) |
| 429 | Rate limited |
| 502 | Payment gateway unavailable |

## 3. Endpoints

### 3.1 Auth & profile

| Method & path | Who | Purpose |
|:---|:---|:---|
| `POST /auth/guest` | Anyone | Body `{nickname}` (2–30 chars). Sets `sc_guest` |
| `POST /auth/register` | Anyone | Body `{email, password, full_name, whatsapp_number?}`. Creates user + wallet, sets `sc_refresh`, returns access token. Links guest requests (AC-F1-05). `409 EMAIL_TAKEN` |
| `POST /auth/login` | Anyone | Body `{email, password}`. Same response and guest linking as register. `401` on bad credentials or suspended |
| `GET /auth/google/start` | Anyone | Redirects to Google |
| `GET /auth/google/callback` | Google | Validates `state`, creates or finds the user, sets `sc_refresh`, links guest requests, redirects to `/` |
| `POST /auth/refresh` | Cookie | Rotates `sc_refresh`, returns `{access_token, expires_in}`. Reuse of a rotated token revokes all tokens of the user |
| `POST /auth/logout` | Cookie | Revokes the refresh token, clears the cookie |
| `POST /auth/password/forgot` | Anyone | Body `{email}`. Always `204` |
| `POST /auth/password/reset` | Anyone | Body `{token, password}`. Revokes all refresh tokens |
| `POST /auth/email/verify` | Anyone | Body `{token}` |
| `GET /me` | Guest, Member | Session info (below) |
| `PATCH /me` | Member | `{full_name?, whatsapp_number?}` |

`GET /me` for a member:
```json
{ "data": {
  "kind": "member", "id": "…", "email": "a@b.id", "full_name": "Budi", "role": "member",
  "wallet_balance_idr": 150000,
  "membership_months": ["2026-11-01"],
  "rewards": [ { "id": "…", "expires_at": "2026-12-10T14:00:00Z" } ],
  "unread_notifications": 2
} }
```
For a guest: `{ "data": { "kind": "guest", "nickname": "Budi" } }`. Anonymous: `401`.

### 3.2 Matches

| Method & path | Who | Purpose |
|:---|:---|:---|
| `GET /matches?from=&to=` | Guest, Member | Calendar. Range clamped silently to `[today−1 month, today+3 months]` (AC-F2-01) |
| `GET /matches/{id}` | Guest, Member | Detail. Members also get the confirmed roster (names). Approvers also get all requests |
| `POST /matches` | Host, Admin | Create |
| `PATCH /matches/{id}` | Host (own), Admin | Edit (AC-F3-04, AC-F3-05). `409` if capacity < seats taken |
| `POST /matches/{id}/cancel` | Superadmin | Cancel, refund, notify (DEC-016) |
| `PUT /matches/{id}/games` | Approver | Body `[{join_request_id, games_played}]`, after the match starts |

Match object:
```json
{
  "id": "a3d1…", "title": "Selasa Malam",
  "starts_at": "2026-12-01T12:00:00Z", "duration_hours": 2,
  "location_name": "GOR Cendrawasih", "location_maps_url": "https://maps.app.goo.gl/…",
  "capacity": 16, "seats_taken": 11,
  "match_type": "intermediate",
  "racket_provided": false, "shuttlecock_provided": true, "equipment_notes": null,
  "price_idr": 50000,
  "status": "scheduled",
  "host": { "id": "…", "full_name": "Sari" },
  "my_request": { "id": "…", "status": "pending" }
}
```
`status` is computed (AC-F2-03). `my_request` is the caller's open request, if any. `court_cost_per_hour_idr` is returned only to hosts and admins.

`POST /matches` body: the writable fields above plus `court_cost_per_hour_idr` and optional `host_id`. If `host_id` is omitted the caller is host (FR-06). A caller with role host may only pass their own id (`403` otherwise). Validation per AC-F3-01 → `422`.

### 3.3 Join requests

| Method & path | Who | Purpose |
|:---|:---|:---|
| `POST /matches/{id}/join-requests` | Guest, Member | Body `{note?}`. Identity comes from the session, never the body. `409` duplicate, match not `scheduled`, or guest already has 3 open requests |
| `GET /me/join-requests` | Guest, Member | Caller's requests, newest first |
| `GET /join-requests?status=pending` | Approver | Queue across the matches the caller may approve |
| `POST /join-requests/{id}/approve` | Approver | See below |
| `POST /join-requests/{id}/reject` | Approver | `pending` → `rejected`. `409` otherwise |
| `POST /join-requests/{id}/cancel` | Owner | Withdraw `pending` or `awaiting_payment` |
| `POST /join-requests/{id}/pay` | Owner (member) | See below |

Join request object:
```json
{
  "id": "9f1c…", "match_id": "a3d1…",
  "player": { "kind": "guest", "name": "Budi" },
  "status": "awaiting_payment",
  "payment_method": null,
  "hold_expires_at": "2026-12-01T10:30:00Z",
  "conversion_required": true,
  "games_played": null,
  "created_at": "2026-12-01T09:12:00Z"
}
```
`conversion_required` is true when the request is `awaiting_payment` and not yet linked to a member (DEC-004).

**Approve.** Allowed from `pending` or `expired`. In one transaction: lock the match, check it is still `scheduled` and has a free seat, then run settlement.
- Covered (membership, reward or wallet) → `200`, `status: "confirmed"`, `payment_method` set.
- Not covered, or the requester is a guest → `200`, `status: "awaiting_payment"`, `hold_expires_at = now + 30 min` (DEC-002, DEC-009).
- `409 ALREADY_PROCESSED`, `409 MATCH_FULL`, `409 MATCH_NOT_OPEN`.

Approval never calls Midtrans, so a gateway outage cannot block it.

**Pay.** Only for the owner's `awaiting_payment` request with time left on the hold.
1. Run settlement (the wallet may have been credited since approval). If it succeeds → `200`, `status: "confirmed"`.
2. Otherwise reuse a still-valid pending payment for this request, or create a Midtrans Snap transaction for `price_idr` with expiry equal to the remaining hold time, and return:
```json
{ "data": {
  "status": "awaiting_payment",
  "payment": { "id": "…", "amount_idr": 50000, "snap_token": "66e4fa55-…",
               "redirect_url": "https://app.midtrans.com/snap/v4/redirection/…",
               "expires_at": "2026-12-01T10:30:00Z" }
} }
```
Errors: `403 CONVERSION_REQUIRED` for a guest, `409 HOLD_EXPIRED`, `502 GATEWAY_UNAVAILABLE`.

The browser opens Snap with `snap_token`, then polls `GET /me/join-requests` every 5 s until the status changes. The webhook, not the browser callback, decides the outcome.

### 3.4 Wallet, membership, donation

| Method & path | Who | Purpose |
|:---|:---|:---|
| `GET /wallets/me` | Member | Balance |
| `GET /wallets/me/transactions` | Member | Own ledger, paginated |
| `POST /wallets/me/topups` | Member | Body `{amount_idr}` ≥ minimum. Creates a `payments` row and Snap transaction (24 h expiry); returns `payment` as in §3.3. No ledger entry until the webhook settles (AC-F6-02) |
| `GET /wallets/{user_id}` , `GET /wallets/{user_id}/transactions` | Admin | Any member's wallet |
| `POST /wallets/{user_id}/credits` | Admin | Body `{amount_idr > 0, note}` (DEC-005). Returns the ledger entry and new balance, then runs settlement for that member's held requests |
| `POST /wallets/{user_id}/adjustments` | Superadmin | Body `{amount_idr ≠ 0, note}`. `409` if it would make the balance negative |
| `POST /memberships` | Member | Body `{month: "2026-12-01"}` (current or next month). Debits wallet. `409` already owned, `409 INSUFFICIENT_BALANCE`, `409 NOT_FOR_SALE` if price unset |
| `POST /donations` | Member | Body `{amount_idr > 0}`. Debits wallet |

Ledger entry:
```json
{ "id": "…", "amount_idr": -50000, "txn_type": "match_payment",
  "join_request_id": "9f1c…", "note": null, "created_by": null,
  "created_at": "2026-12-01T10:02:11Z" }
```

### 3.5 Midtrans webhook

`POST /webhooks/midtrans` — public, no session.

1. Verify `signature_key == SHA512(order_id + status_code + gross_amount + SERVER_KEY)`. Mismatch → `403`.
2. Find the payment by `order_id` (`SC-<payment id>`). Unknown → `404`.
3. Lock the payment row. Store the payload. If already `settled` → `200` (idempotent).
4. If `transaction_status` is `settlement` (or `capture` with `fraud_status = accept`) and `gross_amount` equals `amount_idr`: mark `settled`, credit the wallet (`topup` entry linked to the payment), then, for a `match` payment, run settlement on its join request. If the request is no longer `awaiting_payment` or the seat is gone, the money stays in the wallet and a "late payment" notification is written.
5. If `expire`, `cancel` or `deny`: mark `expired` or `failed`. The join request is governed by its own hold timer.
6. Respond `200`.

All of step 4 is one database transaction.

### 3.6 History & media

| Method & path | Who | Purpose |
|:---|:---|:---|
| `GET /history` | Member | Matches the caller attended, newest first, paginated |
| `GET /history?scope=all` | Admin | All completed matches of the last 3 months |
| `GET /matches/{id}/media` | Attendees, host, Admin | List |
| `POST /matches/{id}/media` | Match host, Admin | `multipart/form-data`, one file. Limits per AC-F7-05 → `422` |
| `GET /media/{id}/file` | Same as list | Streams the file |
| `DELETE /media/{id}` | Match host, Admin | Removes row and file |

Media are fetched with the bearer header and shown through object URLs, so files are never public.

### 3.7 Admin

| Method & path | Who | Purpose |
|:---|:---|:---|
| `GET /users?q=` | Admin | Search by name or email |
| `PATCH /users/{id}` | Superadmin | `{role?, status?}`. Not on self |
| `GET /finance/summary?from=&to=` | Admin | Figures of AC-F10-01 |
| `GET /expenses?from=&to=` | Admin | List |
| `POST /expenses` | Superadmin | `{category, amount_idr, spent_on, note?}` |
| `DELETE /expenses/{id}` | Superadmin | Remove |
| `GET /settings` | Admin | Read |
| `PATCH /settings` | Admin: `reward_enabled`; Superadmin: all | Update |

### 3.8 Notifications & health

| Method & path | Who | Purpose |
|:---|:---|:---|
| `GET /notifications` | Member | Newest first, paginated |
| `POST /notifications/read` | Member | Body `{ids: []}` or `{all: true}` |
| `POST /invitations` | Host+ | Body `{match_id?, contacts: []}`, 1 to 20 contacts. A contact with `@` is emailed, any other is sent by WhatsApp. With `match_id` (caller must manage the match) the message links to the match; without it (Admin+) it links to registration. Nothing is stored. Returns `[{contact, sent, error}]`. Rate limited |
| `GET /whatsapp` | Superadmin | Link state of the WhatsApp gateway: `{enabled, status, number, name, qr}`. `qr` is a PNG data URL while `status` is `SCAN_QR_CODE`; `WORKING` means linked. Starts the session when needed |
| `POST /whatsapp/logout` | Superadmin | Unlinks the WhatsApp account. `204` |
| `GET /healthz` | Anyone | `200 {"status":"ok","features":{"gateway":bool,"google":bool,"email":bool}}` when the database answers; `features` tells the web app which optional integrations are configured |

### 3.9 Court rotation (FR-19, F11)

All paths are under `/matches/{id}/rotation`. `GET` is open to any signed-in member; every other call needs the match host, an admin or a superadmin, and returns `409 MATCH_NOT_OPEN` for a cancelled match. Every call returns the whole board (below), so the screen redraws from one response.

| Method & path | Purpose |
|:---|:---|
| `GET /matches/{id}/rotation` | The board |
| `PATCH /matches/{id}/rotation` | Body `{courts?: 1..20, singles?: bool}`. `409 COURT_BUSY` when removing a court with an open turn, or changing format while any turn is open |
| `PATCH /matches/{id}/rotation/courts/{court}` | Body `{gender_mode?: any\|mixed\|men\|women, level_mode?: off\|balanced\|mixed}` |
| `POST /matches/{id}/rotation/players` | Body `{join_request_ids: [], state: waiting\|resting\|left\|absent}`. `waiting` = arrived or back from rest. `409 PLAYER_ON_COURT`, `409 PLAYER_HAS_GAMES` (for `absent`) |
| `PATCH /matches/{id}/rotation/players/{join_request_id}` | Body `{gender?: "M"\|"F"\|"", level?: 0..3}`; `""` and `0` clear. `409 PLAYER_NOT_ARRIVED` |
| `POST /matches/{id}/rotation/courts/{court}/next` | Sets the court's next turn, replacing any earlier one. No body: picked by the rules (`409 NOT_ENOUGH_PLAYERS`). Body `{team_a: [], team_b: []}`: chosen by hand from waiting players |
| `DELETE /matches/{id}/rotation/games/{game_id}` | Clears a next turn. `409 GAME_STARTED` |
| `POST /matches/{id}/rotation/games/{game_id}/start` | Next turn → running. `409 COURT_BUSY` while the court's game runs |
| `POST /matches/{id}/rotation/games/{game_id}/finish` | Optional body `{score_a, score_b}`. Running → done; updates `games_played` (AC-F11-09) |
| `PATCH /matches/{id}/rotation/games/{game_id}` | Body `{score_a, score_b}` for a finished game. `409 GAME_NOT_DONE` |

Board:
```json
{
  "singles": false,
  "courts": [{ "court": 1, "gender_mode": "any", "level_mode": "off" }],
  "players": [{
    "join_request_id": "…", "name": "Sari", "state": "waiting",
    "gender": "F", "level": 2, "arrived_at": "…", "wait_since": "…",
    "games": 1, "effective_games": 1, "minutes_played": 14,
    "queued": false, "queue_position": 3
  }],
  "games": [{
    "id": "…", "court": 1, "status": "playing",
    "team_a": ["…", "…"], "team_b": ["…", "…"],
    "score_a": null, "score_b": null, "started_at": "…", "ended_at": null
  }]
}
```
`state` is `absent`, `waiting`, `playing`, `resting` or `left`. `queued` means the player is in a court's next turn. `queue_position` (1-based) is set for waiting players who are free to be picked.
