import { defineConfig, loadEnv } from "vite";
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

// A production bundle built without VITE_SENTRY_DSN has no error monitoring at
// all: Vite inlines the var at build time, so `if (import.meta.env.VITE_SENTRY_DSN)`
// in main.tsx folds to `false` and @sentry/react is tree-shaken out. That failure
// is invisible at runtime — the app works, it just never reports — so say it loudly
// here, where it lands in the deploy log.
function warnIfUnmonitored(mode: string) {
  const env = loadEnv(mode, process.cwd(), "");
  if (!env.VITE_SENTRY_DSN) {
    console.warn(
      "\n\x1b[33m[sentry] VITE_SENTRY_DSN is not set — this build ships with NO frontend\n" +
        "         error monitoring. Set it on the client service and rebuild.\n" +
        "         See client/.env.example.\x1b[0m\n",
    );
  } else if (!process.env.SENTRY_AUTH_TOKEN) {
    console.warn(
      "\n\x1b[33m[sentry] DSN set but SENTRY_AUTH_TOKEN is not — source maps will not be\n" +
        "         uploaded, so production stack traces stay minified.\x1b[0m\n",
    );
  }
}

// In dev, proxy /api to the local API server so cookies are same-origin.
export default defineConfig(({ command, mode }) => {
  if (command === "build") warnIfUnmonitored(mode);
  return {
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
  };
});
