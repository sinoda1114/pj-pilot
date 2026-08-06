import { defineConfig } from "drizzle-kit";

export default defineConfig({
  out: "./drizzle",
  schema: "./lib/db/schema/index.ts",
  dialect: "turso",
  dbCredentials: {
    url: process.env.TURSO_DATABASE_URL ?? "file:local.db",
    authToken: process.env.TURSO_AUTH_TOKEN,
  },
});
