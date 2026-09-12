import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "test/browser", testMatch: "*.spec.mjs", workers: 1,
  use: { baseURL: "http://127.0.0.1:4179", browserName: "chromium", trace: "retain-on-failure" },
  webServer: { command: "node test/browser/server.mjs", url: "http://127.0.0.1:4179", reuseExistingServer: false },
});
