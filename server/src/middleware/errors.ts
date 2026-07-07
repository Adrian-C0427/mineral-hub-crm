import type { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";

/** Throwable with an HTTP status. */
export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Wrap async route handlers so rejections reach the error middleware. */
export function asyncHandler<T extends Request>(
  fn: (req: T, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: T, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

export function notFound(_req: Request, res: Response): void {
  res.status(404).json({ error: "Not found" });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ZodError) {
    res.status(400).json({ error: "Validation failed", details: err.flatten() });
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  // A rejected Origin is a client/config problem, not a server fault — surface
  // it as 403 with a clear message instead of a misleading "Internal server error".
  if (err instanceof Error && err.message.startsWith("Origin not allowed by CORS")) {
    res.status(403).json({ error: "This app's address isn't allowed to call the API (CORS). Check the server's CORS_ORIGINS setting." });
    return;
  }
  // Never leak internals; passwords/secrets are never logged.
  console.error("Unhandled error:", err instanceof Error ? err.message : err);
  res.status(500).json({ error: "Internal server error" });
}
