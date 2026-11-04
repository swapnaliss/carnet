.PHONY: up down reset check db-up db-roles db-migrate
COMPOSE ?= docker compose

# Everything: Postgres, the web image and the worker image.
up:
	$(COMPOSE) up -d --build --wait

down:
	$(COMPOSE) down

# Drop the Postgres volume and bring a healthy database back, migrated. A fresh volume runs
# packages/db/sql/roles.sql from docker-entrypoint-initdb.d. Needs DATABASE_MIGRATION_URL.
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
