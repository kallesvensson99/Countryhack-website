import { execSync } from "node:child_process";

/** Applies all migrations to the *test* database before the suite runs. */
export default function setup() {
  const url = process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/ccss_test";
  if (!/_test(\?|$)/.test(url)) throw new Error("TEST_DATABASE_URL must point at a database whose name ends in _test");
  execSync("npx prisma migrate deploy", { stdio: "inherit", env: { ...process.env, DATABASE_URL: url } });
}
