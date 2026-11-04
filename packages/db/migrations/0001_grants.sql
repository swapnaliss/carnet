-- Custom migration (M1-02): privileges for the app role, run by the migration role that owns the
-- database and every table (ADR 0013). The roles themselves come from packages/db/sql/roles.sql.
-- carnet_app: CONNECT + USAGE; SELECT/INSERT/UPDATE/DELETE on tables; audit_log INSERT/SELECT only;
-- no CREATE on the schema or database, no TEMP, never an owner (so no ALTER, DROP or TRUNCATE).
REVOKE ALL ON SCHEMA public FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO carnet_app;
--> statement-breakpoint
DO $$
BEGIN
  EXECUTE format('REVOKE CREATE, TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('REVOKE CREATE, TEMPORARY ON DATABASE %I FROM carnet_app', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO carnet_app', current_database());
END
$$;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO carnet_app;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO carnet_app;
--> statement-breakpoint
-- Tables created by later migrations get the same DML grants; an append-only table revokes in its own
-- migration, as audit_log does below.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO carnet_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO carnet_app;
--> statement-breakpoint
REVOKE ALL ON TABLE audit_log FROM carnet_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE audit_log TO carnet_app;
--> statement-breakpoint
-- The single system_flags row the kill switch reads (caps: USD 10.00 per day, USD 1.00 per run, the
-- .env.example defaults MODEL_DAILY_SPEND_CAP_USD and MODEL_PER_RUN_CAP_USD).
INSERT INTO system_flags (id, agents_enabled, execution_enabled, daily_spend_cap_minor, per_run_cap_minor, cap_currency)
VALUES (1, true, true, 1000, 100, 'USD')
ON CONFLICT (id) DO NOTHING;
