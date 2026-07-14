import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { sentryVitePlugin } from "@sentry/vite-plugin";

// Upload source maps to Sentry only when a build-time auth token is present, so
// local/PR builds without Sentry credentials still succeed.
const sentryUpload = process.env.SENTRY_AUTH_TOKEN
  ? [sentryVitePlugin({
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
      authToken: process.env.SENTRY_AUTH_TOKEN,
    })]
  : [];

// In dev, proxy /api to the local API server so cookies are same-origin.
export default defineConfig({
  // Emit source maps so Sentry can map minified stack traces back to source.
  build: { sourcemap: true },
  // A single React instance no matter where a dependency resolves from (the
  // workspace hoists some packages to the repo root) — duplicates break hooks.
  resolve: { dedupe: ["react", "react-dom"] },
  plugins: [react(), ...sentryUpload],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.VITE_PROXY_TARGET || "http://localhost:4000",
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: Number(process.env.PORT) || 4173,
    host: "0.0.0.0",
    // Railway serves the preview behind its proxy; allow its hostnames.
    allowedHosts: true,
  },
});
