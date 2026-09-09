-- Reverse of 002_enums. Down-migrations are never run in production
-- (PLAN-EXECUTION.md Part I); they are how a developer resets locally,
-- and CI rehearses up → down → up on a clean database.
--
-- No table depends on these yet when this runs in the cycle, but the
-- rehearsal drops 003's tables first anyway; plain DROP TYPE here would
-- fail loudly if a later migration ever tried to wind back past a
-- dependent table, which is the behaviour we want.

DROP TYPE IF EXISTS consent_kind;
DROP TYPE IF EXISTS device_location_permission;
DROP TYPE IF EXISTS location_request_mode;
DROP TYPE IF EXISTS ping_source;
DROP TYPE IF EXISTS reconciliation_status;
DROP TYPE IF EXISTS attachment_kind;
DROP TYPE IF EXISTS attachment_owner_type;
DROP TYPE IF EXISTS product_category;
DROP TYPE IF EXISTS sales_card_status;
DROP TYPE IF EXISTS payment_status;
DROP TYPE IF EXISTS payment_mode;
DROP TYPE IF EXISTS collection_mode;
DROP TYPE IF EXISTS event_source;
DROP TYPE IF EXISTS job_event_type;
DROP TYPE IF EXISTS cancellation_reason;
DROP TYPE IF EXISTS job_priority;
DROP TYPE IF EXISTS job_status;
DROP TYPE IF EXISTS employee_role;
