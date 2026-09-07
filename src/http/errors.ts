import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Express 4 does not forward rejected promises from an async handler to the
 * error middleware. The rejection escapes as an unhandledRejection, which Node
 * 22 turns into an uncaught exception and the process exits. The request that
 * caused it never gets a response either.
 *
 * Every async route handler goes through this. Express 5 does it natively, so
 * this wrapper can be deleted if the framework is upgraded.
 */
export function wrap(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

interface HttpError extends Error {
  status?: number;
  statusCode?: number;
}

/** Terminal error middleware. Must be mounted after every route. */
export const errorHandler: ErrorRequestHandler = (err: HttpError, req, res, next) => {
  // Response already started, so the only correct move is to let Express abort it.
  if (res.headersSent) return next(err);

  const raw = err?.status ?? err?.statusCode;
  const status = typeof raw === 'number' && raw >= 400 && raw < 600 ? raw : 500;

  console.error('[error]', req.method, req.path, status, err?.stack ?? err);

  // Detail stays in the log. A 4xx message describes the caller's own mistake
  // and is safe to echo; a 5xx message can carry driver internals and paths.
  res.status(status).json({ error: status < 500 ? (err?.message ?? 'bad request') : 'internal error' });
};

/**
 * Last resort. Anything reaching here has already escaped the request scope, so
 * the process state is not trustworthy: log and let the restart policy take over
 * rather than continuing on.
 */
export function installProcessHandlers(): void {
  process.on('unhandledRejection', (reason) => {
    console.error('[fatal] unhandled rejection', reason);
    process.exit(1);
  });
  process.on('uncaughtException', (err) => {
    console.error('[fatal] uncaught exception', err);
    process.exit(1);
  });
}
