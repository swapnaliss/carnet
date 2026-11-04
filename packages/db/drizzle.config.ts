// drizzle-kit config. drizzle-kit resolves paths against the working directory (and mangles absolute
// ones), so they are made relative to it: the config works from the repo root and from the package.
// Migrations run as the migration role (DATABASE_MIGRATION_URL), never as the app role.
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "drizzle-kit";

const here = relative(process.cwd(), dirname(fileURLToPath(import.meta.url))) || ".";

export default defineConfig({
  dialect: "postgresql",
  schema: join(here, "src/schema/index.ts"),
  out: join(here, "migrations"),
  dbCredentials: { url: process.env.DATABASE_MIGRATION_URL ?? "" },
  migrations: { table: "__drizzle_migrations", schema: "drizzle" },
  strict: true,
  verbose: true,
});
