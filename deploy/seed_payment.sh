#!/bin/sh
# Loads the club's payment details (FR-22) into this stack's database and media volume.
# The real values never go into git: copy payment.example.json to payment.local.json (ignored),
# fill it in, then run from this directory on the server:
#   ./seed_payment.sh payment.local.json payment-qris.local.webp
# The same details can be edited later in Admin > Pembayaran.
set -eu
json=${1:?usage: seed_payment.sh <payment.json> [qris-image]}
img=${2:-}

field() { python3 -c 'import json,sys; v=json.load(open(sys.argv[1]))[sys.argv[2]]; print(v if isinstance(v,str) else json.dumps(v))' "$json" "$1"; }

docker compose exec -T db psql -U shuttlecircle -v ON_ERROR_STOP=1 \
  -v holder="$(field holder)" -v number="$(field ewallet_number)" -v names="$(field ewallet_names)" -v banks="$(field banks)" <<'SQL'
UPDATE settings SET pay_holder = nullif(:'holder', ''), pay_ewallet_number = nullif(:'number', ''),
  pay_ewallet_names = nullif(:'names', ''),
  pay_banks = (SELECT coalesce(jsonb_agg(b), '[]') FROM jsonb_array_elements(:'banks'::jsonb) b WHERE b->>'number' <> '');
SQL

if [ -n "$img" ]; then
  ext=${img##*.}
  name="qris-seed.$ext"
  docker compose cp "$img" "api:/media/$name"
  docker compose exec -T db psql -U shuttlecircle -v ON_ERROR_STOP=1 -c "UPDATE settings SET pay_qris_path = '$name'"
fi
docker compose exec -T db psql -U shuttlecircle -tAc "SELECT 'qris=' || coalesce(pay_qris_path, '-') || ' ewallet=' || coalesce(pay_ewallet_number, '-') || ' banks=' || jsonb_array_length(pay_banks) FROM settings"
