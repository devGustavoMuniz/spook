import { defineConfig } from "orval";

const input = "../../server/api/openapi.yaml";

export default defineConfig({
  api: {
    input,
    output: {
      mode: "tags-split",
      target: "src/api/endpoints",
      schemas: "src/api/model",
      client: "react-query",
      httpClient: "fetch",
      clean: true,
      override: {
        mutator: { path: "./src/http.ts", name: "http" },
        fetch: { includeHttpResponseReturnType: false },
      },
    },
  },
  zod: {
    input,
    output: {
      mode: "tags-split",
      target: "src/api/zod",
      client: "zod",
      fileExtension: ".zod.ts",
      clean: true,
    },
  },
});
