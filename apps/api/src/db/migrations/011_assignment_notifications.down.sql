DROP INDEX IF EXISTS held_notifications_unreleased_idx;
DROP TABLE IF EXISTS held_notifications;
ALTER TABLE devices DROP COLUMN IF EXISTS failure_reason;
