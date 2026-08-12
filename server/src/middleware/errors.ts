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
  // body-parser (express.json) signals a rejected payload — over the size limit,
  // or malformed JSON — by throwing an Error that carries an HTTP status instead
  // of extending HttpError. Those fell through to the 500 branch below, so a
  // caller who simply posted too much data was told the SERVER had failed, and a
  // plain client mistake was logged as an internal fault. Only 4xx statuses are
  // honoured here: anything else is a real fault and must not be able to
  // downgrade itself out of the 500 path by carrying a status field.
  const declared = Number(
    (err as { status?: number }).status ?? (err as { statusCode?: number }).statusCode ?? 0,
  );
  if (err instanceof Error && Number.isInteger(declared) && declared >= 400 && declared < 500) {
    const tooLarge = (err as { type?: string }).type === "entity.too.large";
    res.status(declared).json({
      error: tooLarge
        ? "Request payload is too large."
        : "The request could not be read. Check the request body and try again.",
    });
    return;
  }

  // Never leak internals; passwords/secrets are never logged.
  console.error("Unhandled error:", err instanceof Error ? err.message : err);
  res.status(500).json({ error: "Internal server error" });
}
