import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cpSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
const pdfRoot = dirname(
  createRequire(import.meta.url).resolve("pdfjs-dist/package.json"),
);
const localPdfAssets = {
  name: "local-pdf-assets",
  configResolved() {
    const target = resolve(import.meta.dirname, "public/pdfjs");
    mkdirSync(target, { recursive: true });
    for (const dir of ["cmaps", "standard_fonts", "wasm"])
      cpSync(resolve(pdfRoot, dir), resolve(target, dir), { recursive: true });
  },
};
export default defineConfig({
  plugins: [localPdfAssets, react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    port: 3000,
    proxy: {
      "/api": {
        target: process.env.VITE_API_PROXY || "http://127.0.0.1:8000",
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
