/// <reference types="vitest/config" />

import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const backend = "http://localhost:8090";

export default defineConfig({
  plugins: [tailwindcss(), react({ babel: { plugins: [["babel-plugin-react-compiler", {}]] } })],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    port: 5180,
    strictPort: true,
    proxy: { "/api": backend, "/healthz": backend },
  },
  test: { environment: "jsdom", globals: true, setupFiles: ["./src/test-setup.ts"], css: false },
});
