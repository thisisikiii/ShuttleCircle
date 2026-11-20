# Product Decisions: ShuttleCircle

This document records the selected answers and supplied text. `Answered` means an option was selected; it does not settle every detail in its description. Option descriptions provide context and do not authorize invented fees, deadlines, or policies. Mark unspecified details as `TBD` in downstream specs.

`Proposed default` (DEC-006 onward) means the design review (2026-11-16) found a gap or contradiction and filled it with the simplest workable rule. The specs are written against these defaults so the build can start. The owner may overrule any of them; change the decision here first, then the specs.

## DEC-001 — How should guest participants be handled beyond the cookie-based nickname session?

**Status:** Answered

**User answer:** Prompt to convert to member: After a guest joins a match, prompt them to create an account so their history and payments persist.

## DEC-002 — When a member's join request is approved, what is the payment timing and confirmation model?

**Status:** Answered

**User answer:** Auto deduct from wallet is the first logic, if no wallet or the balance isn't sufficient, it will have a pay before confirm QR, the seat is held for 30 minutes until the payments confirm, if not then the registration will be taken down or cancelled

## DEC-003 — When a 30-minute QR seat hold expires unpaid, what should happen to the freed seat?

**Status:** Answered

**User answer:** Auto-cancel, no auto-promotion: Request is cancelled and member notified; host manually approves the next request.

## DEC-004 — How do guests (cookie-only nickname) pay for a match after the host approves them?

**Status:** Answered

**User answer:** Guests must convert to member to pay: Guest can only complete payment by creating an account first.

## DEC-005 — How do members fund their personal wallet for top-ups and monthly membership?

**Status:** Answered

**User answer:** Gateway plus manual admin credit: Gateway top-ups plus admins can manually credit cash payments received offline.

---

## DEC-006 — Backend shape

**Status:** Proposed default

**Default:** One Rust (Axum) service with an in-process background worker, not microservices.

**Why:** Approval, wallet debit and seat confirmation must commit in one database transaction. Splitting them across services turns that into a distributed transaction, and several containers use more memory than one, which defeats the stated goal of low VPS usage.

## DEC-007 — Frontend runtime

**Status:** Proposed default

**Default:** Next.js (App Router) as stated in the PRD, built as a standalone Node container, with all authenticated data fetched in the browser.

**Smaller option:** A Vite + React static build served by Caddy. It removes the Node container (about 150 MB RAM) and loses nothing this app needs, because SEO is not a goal and the access token lives in browser memory, so server rendering cannot fetch user data anyway.

## DEC-008 — Guest cookie lifetime and linkage

**Status:** Proposed default

**Default:** The guest cookie is persistent for 30 days (not browser-session bound). Each guest join request stores the cookie's `sid`, and conversion links requests by that `sid`.

**Why:** Approval may take hours (KPI p95 is 12 hours). A browser-session cookie is gone by then, so the approved guest could never be matched to the request. The server also cannot detect a cleared cookie, so the old "cron marks orphaned requests" rule was impossible; requests now simply close when the match starts.

## DEC-009 — When the 30-minute hold starts

**Status:** Proposed default

**Default:** The hold starts at approval, for members and guests alike (literal reading of DEC-002). A guest must convert and pay inside the same 30 minutes. A host may approve an `expired` request again, which starts a new hold; this stays manual, so DEC-003 holds.

**Risk to confirm:** If the host approves while the player is offline or asleep, the hold expires unseen. The alternative is to start the 30 minutes when the player opens the payment page, with a longer outer deadline. Not chosen because it changes DEC-002.

## DEC-010 — Midtrans integration model

**Status:** Proposed default

**Default:** Midtrans Snap for both seat payment and top-up, with the Snap expiry set to the remaining hold time. The payer (not the approver) creates the payment. Every gateway payment is first credited to the payer's wallet and the seat fee is then debited in the same transaction.

**Why:** The original approve endpoint returned the QR to the host, who is not the payer, and failed the approval when Midtrans was down. Routing all money through the wallet ledger gives one webhook path and one ledger, and a payment that arrives after the hold expired or the seat was taken simply stays as wallet balance, so no gateway refund is needed.

**TBD:** Who bears the gateway fee (default: the community absorbs it; the player pays the listed price). Minimum top-up (default Rp 10.000).

## DEC-011 — Notification channels in the first release

**Status:** Decided by the owner on 2026-11-17 (WhatsApp added)

**Decision:** In-app, email, and WhatsApp through a linked account. Email goes through any SMTP relay (Brevo on the test box, port 2525). WhatsApp goes through a WAHA gateway container (engine NOWEB, which is Baileys): the superadmin links the club number once by QR code in Admin > WhatsApp, like WhatsApp Web. Members who gave a WhatsApp number get a WhatsApp copy of each notification. Hosts and admins can send invitations by email or WhatsApp.

**Why:** The owner asked for WhatsApp from the superadmin number without the Meta Business process. The official WhatsApp Business API needs Meta business verification, pre-approved templates and per-message fees.

**Risk accepted:** The gateway is unofficial and breaks WhatsApp's terms. WhatsApp can ban the linked number, mostly when it messages people who have not saved it. The build limits the pace (5 notification messages per 30 seconds, 1 second between invitations, 20 contacts per invitation call) but cannot remove the risk. A spare number is safer than a personal one. Guests have no contact channel and see their status on the site only.

## DEC-012 — Meaning of "attended" and "games per player"

**Status:** Proposed default

**Default:** A player attended a match when their request is `confirmed` and the match has ended without being cancelled. The host, or an admin, enters `games_played` per player after the match. Media upload is allowed to the match host and to admins and superadmins.

**Why:** No attendance or game data existed in the model, yet history, media rights and the reward all depended on it. No-show tracking is not added.

## DEC-013 — Monthly membership

**Status:** Proposed default

**Default:** Membership covers one calendar month (Asia/Jakarta), is bought from the wallet at a price held in settings, and makes the seat fee zero. The member still requests to join and still needs approval, so capacity stays under host control.

**TBD:** Membership price (blocks only the purchase feature).

## DEC-014 — Shuttlecock deposit

**Status:** Proposed default

**Default:** A voluntary donation debited from the wallet into community funds. It is not a second per-member balance.

## DEC-015 — Reward rules left open by FR-16

**Status:** Proposed default

**Default:** Each attended match counts toward one reward only. The reward is applied automatically to the next approval before the wallet is charged, and must be used (approval time) within one month of the fifth match. Matches joined with a free seat count toward the next reward.

## DEC-016 — Match cancellation

**Status:** Proposed default

**Default:** Cancelling a match credits every confirmed player's wallet with the fee they paid and restores a used reward or leaves membership untouched. Gateway refunds stay out of scope. A player who withdraws from a confirmed seat gets no automatic refund; an admin may credit manually.

## DEC-017 — Media storage

**Status:** Proposed default

**Default:** Files on a Docker volume on the VPS, served through the API. Photos up to 10 MB (JPEG, PNG, WebP); videos up to 100 MB (MP4), no transcoding.

**Smaller option:** Photos only, videos as pasted links (YouTube or Drive). Saves disk and bandwidth.

## DEC-018 — Build and deploy

**Status:** Proposed default

**Default:** Container images are built off the VPS (laptop or CI) and pushed to a registry; the VPS only pulls and runs them with Docker Compose.

**Why:** A Rust release build and a Next.js build each need about 2 GB of RAM and can exhaust a small VPS.

## DEC-019 — Locale

**Status:** Proposed default

**Default:** Currency IDR (whole rupiah, no decimals), timezone Asia/Jakarta for display and for month boundaries, interface text in Bahasa Indonesia.

## DEC-020 — Bootstrap and host participation

**Status:** Proposed default

**Default:** The first superadmin is created by a command run on the server, never by self-registration. A host who plays requests to join like anyone else (and may approve their own request), so they count toward capacity and pay the fee.

## DEC-021 — Court rotation rules

**Status:** Requested by the owner on 2026-11-19 (FR-19)

**Default:** Turn order is fewest games, then longest wait, then earliest arrival. Late arrivals and returning players start at the current minimum game count. Teams are queue positions 1 + 4 against 2 + 3. Gender and level are optional per court; level never lets a player with more games go ahead. The board is kept on the server per match, its players are the confirmed roster, and finished games feed `games_played`. These rules were taken from the owner's reference tool (a free court-queue web app), observed by testing it, not by copying its code.

**Scoring (added 2026-11-20):** one game per court turn, BWF rally scoring to 21 (win by 2, 30 caps). Live score is kept on the server so every phone shows the same number; the leaderboard is per match and computed, never stored.

**Not included:** a shared group queue for any free court, court names, pasting player lists, and gender or level in the user profile (they are set per match on the board).

**Why:** It puts the "who plays next" step of a social session into the app the club already uses, with the same fairness rules the owner already trusts, and with no new screens outside the match page.

---

## Inputs still required from the owner

These cannot be defaulted. Each blocks only the item named.

| Input | Blocks |
|:---|:---|
| Domain name pointed at the VPS (or accept `<ip>.sslip.io`) | Public deploy, Google sign-in, Midtrans webhook |
| VPS address, RAM and disk | Deploy sizing |
| Midtrans server key and client key (sandbox first) | Gateway payment and top-up; wallet and manual credit work without it |
| Google OAuth client ID and secret | Google sign-in; email and password work without it |
| SMTP host and credentials | Email notifications, email verification, password reset |
| Offsite backup target | Offsite copy; local nightly dumps work without it |
