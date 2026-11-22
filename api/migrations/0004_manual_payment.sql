-- Manual payment (FR-22): QRIS image, e-wallet number and bank accounts shown to members,
-- and payment claims that an admin confirms. The values live only in the database, never in git.
ALTER TABLE settings
  ADD COLUMN pay_qris_path      text,                        -- file in the media volume
  ADD COLUMN pay_holder         text,                        -- account holder name shown under the accounts
  ADD COLUMN pay_ewallet_number text,
  ADD COLUMN pay_ewallet_names  text,                        -- e.g. 'GoPay, DANA, ShopeePay, OVO'
  ADD COLUMN pay_banks          jsonb NOT NULL DEFAULT '[]'; -- [{"bank": "BCA", "number": "..."}]

CREATE TYPE claim_status AS ENUM ('pending','confirmed','rejected');

CREATE TABLE payment_claims (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id),
  join_request_id uuid REFERENCES join_requests(id),   -- null for a wallet top-up
  amount_idr      bigint NOT NULL CHECK (amount_idr > 0),
  method          text NOT NULL,                       -- qris, ewallet, or a bank name
  note            text,
  status          claim_status NOT NULL DEFAULT 'pending',
  decided_by      uuid REFERENCES users(id),
  wallet_txn_id   uuid REFERENCES wallet_txns(id),     -- the manual credit made on confirmation
  created_at      timestamptz NOT NULL DEFAULT now(),
  decided_at      timestamptz
);
CREATE INDEX payment_claims_status_idx ON payment_claims(status, created_at);
CREATE INDEX payment_claims_user_idx   ON payment_claims(user_id, created_at);
