.PHONY: up down reset check db-up
COMPOSE ?= docker compose

# Everything: Postgres, the web image and the worker image.
up:
	$(COMPOSE) up -d --build --wait

down:
	$(COMPOSE) down

# Drop the Postgres volume and bring a healthy database back. Migrations are a no-op until M1-02.
reset:
	$(COMPOSE) down -v
	$(COMPOSE) up -d --wait postgres
	@echo "migrations: none yet (M1-02)"

db-up:
	$(COMPOSE) up -d --wait postgres

check:
	npm run typecheck && npm run lint && npm test
