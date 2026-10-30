/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react({ babel: { plugins: [["babel-plugin-react-compiler", {}]] } })],
  server: {
    port: 5180,
    strictPort: true,
    proxy: { "/api": { target: "http://localhost:8090", rewrite: (p) => p.replace(/^\/api/, "") } },
  },
  test: { environment: "jsdom", globals: true, setupFiles: ["./src/test-setup.ts"] },
});
