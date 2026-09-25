import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  plugins: [svelte()],
  server: { port: 5173 },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 30000
  }
});
