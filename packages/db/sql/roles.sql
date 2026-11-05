-- Carnet database roles (ADR 0013). Run ONCE per cluster with the admin (superuser) connection,
-- connected to the application database. Idempotent: safe to re-run.
--
--   carnet_migrator  owns the database, the schema and every table; runs migrations (DDL).
--                    CREATEDB lets the test harness create per-worker databases.
--   carnet_app       the application's login: DML only, granted by the migrations
--                    (see migrations/0001_grants.sql). It cannot create, alter, drop or truncate.
--
-- Passwords come from psql variables; the defaults are synthetic and for the local Docker stack only:
--   psql "$ADMIN_URL" -v ON_ERROR_STOP=1 \
--     -v migrator_password="..." -v app_password="..." -f packages/db/sql/roles.sql
-- Locally, docker compose runs this file from docker-entrypoint-initdb.d on a fresh volume.

\if :{?migrator_password}
\else
  \set migrator_password carnet_migrator
\endif
\if :{?app_password}
\else
  \set app_password carnet_app
\endif

SELECT NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'carnet_migrator') AS create_migrator \gset
\if :create_migrator
  CREATE ROLE carnet_migrator;
\endif
SELECT NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'carnet_app') AS create_app \gset
\if :create_app
  CREATE ROLE carnet_app;
\endif

-- Hosted (managed Postgres): the admin user is not a superuser, so it may not name SUPERUSER, CREATEDB,
-- REPLICATION or BYPASSRLS in ALTER ROLE (even to turn them off). CREATE ROLE already defaults all of
-- them to off, so the hosted branch sets only LOGIN, NOINHERIT and the password. Pass `-v hosted=1`
-- (scripts/setup.ts --roles does). CREATEDB is for the test harness only and is not granted there.
\if :{?hosted}
  ALTER ROLE carnet_migrator WITH LOGIN PASSWORD :'migrator_password';
  ALTER ROLE carnet_app WITH LOGIN NOINHERIT PASSWORD :'app_password';
\else
  ALTER ROLE carnet_migrator WITH LOGIN NOSUPERUSER CREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
    PASSWORD :'migrator_password';
  ALTER ROLE carnet_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS
    PASSWORD :'app_password';
\endif

-- The app role is never a member of the migrator (it would inherit ownership).
SELECT EXISTS (
  SELECT 1 FROM pg_auth_members m
  JOIN pg_roles r ON r.oid = m.roleid JOIN pg_roles u ON u.oid = m.member
  WHERE r.rolname = 'carnet_migrator' AND u.rolname = 'carnet_app'
) AS app_in_migrator \gset
\if :app_in_migrator
  REVOKE carnet_migrator FROM carnet_app;
\endif

-- The migrator owns the application database, so it owns its public schema (pg_database_owner)
-- and can create the drizzle migrations schema.
-- Hosted: changing the owner needs the right to SET ROLE to the new owner.
\if :{?hosted}
  GRANT carnet_migrator TO CURRENT_USER WITH SET TRUE;
\endif
SELECT format('ALTER DATABASE %I OWNER TO carnet_migrator', current_database()) \gexec
