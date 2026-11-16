-- WhatsApp copy of a notification (DEC-011). Null = not sent yet; the worker tries once.
ALTER TABLE notifications ADD COLUMN wa_sent_at timestamptz;
