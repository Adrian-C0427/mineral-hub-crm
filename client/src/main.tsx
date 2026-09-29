import React from "react";
import ReactDOM from "react-dom/client";
import * as Sentry from "@sentry/react";
import { BrowserRouter } from "react-router-dom";
import { AuthProvider } from "./auth/AuthContext";
import { ThemeProvider } from "./theme";
import { StagesProvider } from "./stages";
import { App } from "./App";
import { ApiError } from "./api/client";
import "./styles.css";
// Phone-only overrides (every rule is inside a phone media query) — after styles.css so they win.
import "./mobile.css";

// Front-end error monitoring — inert until VITE_SENTRY_DSN is set at build time.
// The var is inlined by Vite during the build, so an unset DSN means this whole
// branch (and @sentry/react with it) is stripped from the bundle. In a production
// build that is a silent monitoring blackout, so leave a breadcrumb in the console.
if (import.meta.env.VITE_SENTRY_DSN) {
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN,
    environment: import.meta.env.MODE,
    tracesSampleRate: 0.1,
    beforeSend(event, hint) {
      // Don't report expected, environmental states that aren't app bugs:
      //  - 401: an expired session; the auth layer clears it and redirects to
      //    login (this is what surfaced as the uncaught MINERAL-HUB-WEB-1).
      //  - status 0: a network failure where the request never reached the API
      //    (Railway cold start / connectivity blip), typed as ApiError(0) by the
      //    client (this is MINERAL-HUB-WEB-2 / WEB-3). A real API/CORS break would
      //    show as a flood in the app, not one transient unhandled rejection.
      const err = hint?.originalException;
      if (err instanceof ApiError && (err.status === 401 || err.status === 0)) return null;
      return event;
    },
  });
} else if (import.meta.env.PROD) {
  console.warn(
    "[sentry] No VITE_SENTRY_DSN was set when this bundle was built — " +
      "frontend errors are not being reported.",
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <ThemeProvider>
          <StagesProvider>
            <App />
          </StagesProvider>
        </ThemeProvider>
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
