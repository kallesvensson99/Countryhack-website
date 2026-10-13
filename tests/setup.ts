// Runs in every test file before imports of app code: point everything at the test DB.
const url = process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/ccss_test";
process.env.DATABASE_URL = url;
process.env.APP_SECRET = "test-secret-test-secret-test-secret-123456";
process.env.APP_URL = "http://localhost:3000";
Object.assign(process.env, { NODE_ENV: "test" });
