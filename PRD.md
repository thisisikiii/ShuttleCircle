# PRD: ShuttleCircle

## 1. Executive Summary & Product Vision
ShuttleCircle is a browser-based community sports management platform built for badminton communities. It covers match scheduling, join requests, approval, payment, wallet management, match documentation and role-based access. It is one responsive web application for desktop, tablet and mobile browsers, backed by a single Rust service chosen for low VPS resource usage. Decisions DEC-001 to DEC-005 are binding. DEC-006 onward are proposed defaults from the design review; see `DECISIONS.md`.

## 2. Problem Statement & Target Users
Community badminton organizers manage match registration, payments and history manually across chat apps, causing overhead, missed payments and limited member retention.

| User | Pain Point |
|:---|:---|
| Community owner (Superadmin/Admin) | Manual roster management, financial tracking and communication |
| Host | No structured way to configure matches, approve join requests or upload media |
| Member | Cannot see match calendar, history, or pay easily |
| Guest | Wants quick join without full account, but must convert to retain history |

## 3. System Scope & User Roles

| Role | Permissions |
|:---|:---|
| Superadmin | Everything an admin can do, plus role management, match cancellation, expense input, wallet adjustments, settings |
| Admin | Approve join requests, configure any match, assign hosts, credit wallets manually, view finance dashboard, view 3-month history, upload media |
| Host | Create and edit own matches, approve join requests for own matches, enter games played, upload media for own matches |
| Member | View calendar (1 month back to 3 months ahead), request join, pay, view own attended history, top up wallet, buy membership, donate, receive reward |
| Guest | Nickname in a signed cookie, view calendar and location, request join, prompted to convert to member once approved |

A user has one global role. Being host of a match is separate: `matches.host_id` names the host, who must hold role host or higher.

## 4. Functional Requirements

- **FR-01** — Guest session: a nickname held in a signed cookie that lasts 30 days (DEC-008). A guest can request to join a match. After approval the guest is prompted to create an account to preserve history and pay (DEC-001).
- **FR-02** — Member authentication: Google sign-in (OAuth2 authorization code) and email + password (Argon2id). The backend issues a JWT access token and a rotating refresh token. Password reset and email verification use an emailed link.
- **FR-03** — Calendar view: scheduled, ongoing and completed matches in calendar form, from 1 month in the past to 3 months ahead.
- **FR-04** — Match creation: admin or host schedules a match with title, start time, location (name and Google Maps link), duration in whole hours, capacity, match type (beginner friendly, intermediate), whether rackets and shuttlecocks are provided, court cost per hour, and price per seat.
- **FR-05** — Match location: all roles can open the location in Google Maps for directions.
- **FR-06** — Host assignment: an admin can assign a host per match; if none is selected the creator is the host.
- **FR-07** — Role-based access control: five roles with a permission matrix enforced by the backend. The interface hides what a role cannot do, but the backend is the authority.
- **FR-08** — Join request flow: every role can request to join. Requests appear in a list for the match host, admins and superadmins to approve or reject.
- **FR-09** — Payment on approval: approval first tries to settle without the gateway, in this order: active membership, unused reward, wallet balance. If none covers the fee, the seat is held for 30 minutes and the player pays through Midtrans. If unpaid when the hold ends, the request expires and the player is notified; the host manually approves another request (DEC-002, DEC-003, DEC-009, DEC-010).
- **FR-10** — Guest payment conversion: an approved guest must create or sign in to a member account before paying (DEC-004). The 30-minute hold covers conversion and payment.
- **FR-11** — Registration confirmation: on successful settlement the player is on the match roster and receives an in-app notification and an email (DEC-011).
- **FR-12** — Match history: admins see all matches of the last 3 months; a member sees only matches they attended, with no time limit. History shows the player list, games played per player, and photos and videos (DEC-012, DEC-017).
- **FR-13** — Wallet top-up: members top up through the gateway; admins credit cash received offline, with a reason (DEC-005).
- **FR-14** — Financial dashboard: admins and superadmins see, for a date range, cash received, fee income, membership income, donations, court costs, other expenses and the total of member wallet balances. Superadmins record expenses (drinking water, shuttlecocks, other).
- **FR-15** — Membership and donation: a member can buy a monthly membership from the wallet (DEC-013) and donate toward shuttlecocks from the wallet (DEC-014).
- **FR-16** — Reward engine: a member who attends 5 matches within 2 months earns 1 free seat valid for 1 month from the fifth match. Admins can switch the promo on or off (DEC-015).
- **FR-17** — Notifications: request approved, payment confirmed, hold expired, request rejected, match cancelled, reward earned. Channels: in-app and email (DEC-011).
- **FR-18** — Match cancellation: a superadmin cancels a match; confirmed players are refunded to their wallets and notified (DEC-016).
- **FR-19** — Court rotation (latest feature, added 2026-11-19): every match gets a rotation board that puts all confirmed players in a fair turn order across the courts. The host or an admin checks players in, sets the number of courts and the format (doubles or singles), and fills each court with one tap. The players who have played the fewest games go first, then those who have waited longest. Each court can limit gender (any, mixed, men, women) and use skill level (off, balanced, mixed). Games are started and finished on the board, with an optional score; finishing a game updates each player's games played (FR-12). Players can rest, return or leave. Other members see the board read-only. Rules in FEATURES.md §13 (F11) and DEC-021.

## 5. Non-Functional Requirements

| Category | Target |
|:---|:---|
| Performance | p95 API response < 300 ms for match and calendar views; calendar usable in < 2 s on a mid-range phone on 4G |
| Resource usage | API container < 100 MB RSS idle; whole stack runs on a VPS with 2 GB RAM |
| Security | Access JWT 15 min; refresh token 7 days, rotated, stored hashed; Argon2id; OAuth2 `state` check; rate limits on auth, join-request and payment endpoints; Midtrans webhook signature check; TLS everywhere |
| Consistency | Seat count, wallet balance and request status change inside one database transaction; capacity can never be exceeded under concurrent approvals |
| Availability | 99.5% on a single VPS; if the gateway is down, wallet and manual credit still work |
| Data retention | Nothing is purged. The admin 3-month history limit is a view filter. Financial ledger entries are never deleted |
| Accessibility | WCAG 2.1 AA |
| Devices | Responsive from 360 px phones to desktop; current Chrome, Safari, Firefox, Edge |

## 6. Technology Stack & Rationale

| Component | Technology | Why |
|:---|:---|:---|
| Backend | Rust, Axum 0.8, Tokio; one service with an in-process worker | Low memory; one transaction boundary for money and seats (DEC-006) |
| Frontend | Next.js App Router, React 19, TypeScript, client-side data fetching | Stated preference (DEC-007 names a smaller option) |
| Database | PostgreSQL 17 with SQLx and SQL migrations | ACID for payments and wallet |
| Auth | JWT + Google OAuth2 + Argon2id, implemented in the backend | No external auth service |
| Payments | Midtrans Snap (QRIS and other methods) | Indonesian payment methods (DEC-010) |
| Hosting | Docker Compose on a VPS, Caddy reverse proxy | Single VPS, automatic TLS |
| Styling | Tailwind CSS v4 + shadcn/ui | Rapid component development |

Versions are minimums; use the current stable release at build time.

## 7. Success Metrics & KPIs

| Metric | Target |
|:---|:---|
| Join request → approval time | p95 < 12 hours |
| Payment success rate | ≥ 90% of approved requests |
| Seat hold expiry rate (unpaid) | < 15% of holds |
| Guest → member conversion after first approval | ≥ 40% |
| Monthly active members | ≥ 70% of registered base |
| Match fill rate | ≥ 80% of capacity |
| Reward redemption rate | ≥ 30% of earned free seats |
| Court rotation fairness | In a session, games played differ by at most 1 between players who were present the whole time |

## 8. Risk Analysis & Mitigation

| Risk | Impact | Mitigation |
|:---|:---|:---|
| Midtrans outage | Gateway payment blocked | Wallet and manual admin credit still settle seats (DEC-005); a manual credit immediately retries the player's held seats |
| Hold expires while the player is offline | Lost registration, expiry KPI missed | Immediate email and in-app notice; host can approve the expired request again (DEC-009) |
| Payment arrives after the hold expired | Player paid but has no seat | Money stays in the player's wallet; player is notified (DEC-010) |
| Guest loses the cookie before approval | Request cannot be claimed | 30-day cookie (DEC-008); unclaimed requests close at match start |
| Midtrans account not approved for QRIS | No QR payment | Sandbox first; manual credit covers the gap; other Snap methods stay available |
| VPS disk filled by videos | Outage | Size limits, disk alert at 80% (DEC-017) |
| VPS too small to build images | Failed deploy | Build off the VPS (DEC-018) |
| Database failure or bad migration | Data loss | Nightly `pg_dump`, dump before each migration, offsite copy |

## 9. Constraints & Assumptions

- Deployed on the owner's VPS with Docker Compose; no Kubernetes; one instance of each container.
- One community per installation.
- Owner inputs still required are listed at the end of `DECISIONS.md`. Until each arrives, only the feature it blocks is unavailable.
- Reward parameters (5 matches, 2 months, 1 month) are fixed; only the on/off switch is configurable.
- Currency IDR, timezone Asia/Jakarta, interface in Bahasa Indonesia (DEC-019).

## 10. Out of Scope

- Native mobile applications (iOS/Android).
- Multi-tenancy or multiple communities on one instance.
- Automated seat promotion or waiting-list automation.
- Advanced accounting (double-entry, tax reports); simple wallet ledger and expense list only.
- Gateway refunds. Refunds are wallet credits only.
- Social features beyond match documentation (no chat, friend lists).
- Offline or PWA mode, push notifications.
- WhatsApp notifications in the first release (DEC-011).
- No-show tracking, video transcoding, real-time sockets (the interface polls).
