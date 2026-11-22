# Sandbox (dev): manual testing before production

URL: https://dev.shuttlecircle.personifinn.site  (production: https://shuttlecircle.personifinn.site)

The sandbox is a small copy of production on the same box (ikiiibox, `~/shuttlecircle-dev`), with its own
database and secrets. Nothing you do there touches production.

| | Sandbox | Production |
|:---|:---|:---|
| Payments | Manual (QRIS, e-wallet, bank) with your real details; nothing is charged unless you actually transfer | Same |
| Email | Off (no real emails) | Brevo |
| WhatsApp | Off | Club number |
| Memory cap | api 128 MB, web 256 MB, db 256 MB, caddy 64 MB | none |
| Rate limit | 200 requests per minute | 10 per minute |

## Release flow

1. New code is deployed to the sandbox first.
2. You test it by hand there (checklist below).
3. Only after your go-ahead is the same commit deployed to production.

## Manual test checklist

- **Members:** open the site in a private window and register a few accounts (one per window). Make one admin in Admin > Anggota.
- **Matches:** create a match, request to join as a member, approve as host or admin.
- **Payment:** with an empty wallet, approval holds the seat; tap **Bayar**, see the QRIS and accounts, tap **Saya sudah bayar**. As admin, open Admin > Pembayaran and tap **Konfirmasi**: the seat becomes confirmed. Try **Tolak** on a top-up claim.
- **Wallet:** Admin credits cash to a member (manual credit), the member buys a membership or donates.
- **Income and expenses:** Admin > Keuangan: add and delete expenses; check the Wallet page dashboard follows.
- **Court rotation:** on a match page, mark players arrived, fill courts, start a game, score it with +1, finish it, check the leaderboard.
- **Reports:** Wallet page > Unduh Excel and Cetak / simpan PDF.

## Commands (on ikiiibox, in `~/shuttlecircle-dev/deploy`)

- Make an account superadmin after registering: `docker compose exec api shuttlecircle create-superadmin --email you@example.com`
- Wipe the sandbox data and start empty: `docker compose down && docker volume rm scdev_pgdata scdev_media && docker compose up -d`
- Logs: `docker compose logs -f api`

The `.env` there sets `COMPOSE_PROJECT_NAME=scdev`, `COMPOSE_FILE=compose.yaml:sandbox/compose.sandbox.yaml`,
`API_IMAGE=scdev-api`, `WEB_IMAGE=scdev-web` (so sandbox builds never replace the production images), `HTTP_PORT=8091`
and an empty `MIDTRANS_SERVER_KEY` (payment is manual).

Payment details: `sh seed_payment.sh payment.local.json payment-qris.local.webp` loads them from the ignored local files (template `../payment.example.json`); Admin > Pembayaran edits them.
