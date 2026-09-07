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
      // A 401 is expected user state (an expired session), not a bug: the auth
      // layer clears the session and redirects to login. Don't report it — this
      // is what surfaced as the uncaught MINERAL-HUB-WEB-1.
      const err = hint?.originalException;
      if (err instanceof ApiError && err.status === 401) return null;
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
