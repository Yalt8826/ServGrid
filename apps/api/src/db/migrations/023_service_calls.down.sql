-- Reverse of 023_service_calls.up.sql. The view goes first (it reads the
-- table), then the table; no other object references either.
DROP VIEW IF EXISTS v_service_calls;
DROP TABLE IF EXISTS customer_follow_ups;
