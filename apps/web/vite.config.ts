/// <reference types="vitest/config" />

import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { versionPlugin } from "./vite-version-plugin";

const backend = "http://localhost:8090";

export default defineConfig({
  plugins: [
    versionPlugin(),
    tailwindcss(),
    react({ babel: { plugins: [["babel-plugin-react-compiler", {}]] } }),
  ],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    port: 5180,
    strictPort: true,
    proxy: { "/api": { target: backend, ws: true }, "/healthz": backend },
  },
  build: {
    rollupOptions: {
      output: {
        // Separa o que muda pouco (React, Radix) do código do app: melhor cache e chunks menores.
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (/node_modules\/(\.pnpm\/)?(react|react-dom|scheduler)[@/]/.test(id)) return "react";
          if (id.includes("@radix-ui")) return "radix";
          return "vendor";
        },
      },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
    css: false,
    // Máquinas carregadas (CI, integração em paralelo) estouravam os 5 s padrão em testes de tela longos.
    testTimeout: 15000,
    exclude: ["e2e/**", "design/**", "node_modules/**"],
  },
});
