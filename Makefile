.PHONY: up down reset check db-up db-roles db-migrate
COMPOSE ?= docker compose
# Local Docker stack only: synthetic defaults from packages/db/sql/roles.sql (same as docker-compose.yml and CI).
# Set DATABASE_MIGRATION_URL in the environment to override; never put a hosted URL here.
POSTGRES_PORT ?= 5432
DATABASE_MIGRATION_URL ?= postgres://carnet_migrator:carnet_migrator@localhost:$(POSTGRES_PORT)/carnet
export DATABASE_MIGRATION_URL

# Everything: Postgres, the web image and the worker image.
up:
	$(COMPOSE) up -d --build --wait

down:
	$(COMPOSE) down

# Drop the Postgres volume and bring a healthy database back, migrated. A fresh volume runs
# packages/db/sql/roles.sql from docker-entrypoint-initdb.d. Uses DATABASE_MIGRATION_URL (local default above).
reset:
	$(COMPOSE) down -v
	$(COMPOSE) up -d --wait postgres
	npm run db:migrate -w packages/db

db-up:
	$(COMPOSE) up -d --wait postgres

# Re-apply the roles on an existing local volume (admin step; idempotent).
db-roles:
	$(COMPOSE) exec -T postgres psql -U carnet -d carnet -v ON_ERROR_STOP=1 < packages/db/sql/roles.sql

db-migrate:
	npm run db:migrate -w packages/db

check:
	npm run typecheck && npm run lint && npm test
