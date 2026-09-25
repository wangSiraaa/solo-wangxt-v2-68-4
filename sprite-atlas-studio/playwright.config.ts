import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60000,
  retries: 0,
  use: {
    baseURL: "http://localhost:4173",
    launchOptions: {
      // 无 GPU 环境下用软件渲染跑 WebGL（PixiJS 预览需要）
      args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"]
    }
  },
  webServer: {
    command: "npm run preview -- --port 4173 --strictPort",
    url: "http://localhost:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 30000
  }
});
