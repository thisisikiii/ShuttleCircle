-- Admin marks a held or expired seat as paid outside the app (cash or a transfer seen in the bank),
-- with no claim from the player and no wallet movement. paid_at dates it for the finance dashboard.
ALTER TYPE payment_method ADD VALUE IF NOT EXISTS 'cash';
ALTER TABLE join_requests ADD COLUMN paid_at timestamptz;
