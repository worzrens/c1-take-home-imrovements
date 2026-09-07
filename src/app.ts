import express from 'express';
import helmet from 'helmet';
import { conversationsRouter } from './routes/conversations.js';
import { messagesRouter } from './routes/messages.js';
import { searchRouter } from './routes/search.ts';
import { authRouter } from './routes/auth.ts';
import { errorHandler } from './http/errors.ts';
import { authenticate, requireSameOrigin } from './auth/middleware.ts';

/**
 * Builds the Express app with every route and middleware mounted, but without
 * touching MySQL, Mongo, Redis or the WebSocket. `src/index.ts` wires those in
 * and starts listening; the tests import this directly and run it on an
 * ephemeral port.
 */
export function createApp() {
  const app = express();

  // Express advertises itself in a response header by default. It tells an
  // attacker what to look up and tells a user nothing.
  app.disable('x-powered-by');

  // The page loads only its own script and stylesheet, so the policy can be
  // strict. 'self' in connect-src covers the same-origin WebSocket; if a browser
  // ever blocks the socket, that directive is the first place to look.
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          'default-src': ["'self'"],
          'script-src': ["'self'"],
          'style-src': ["'self'"],
          'img-src': ["'self'", 'data:'],
          'connect-src': ["'self'"],
          'form-action': ["'self'"],
          'frame-ancestors': ["'none'"],
          'base-uri': ["'none'"],
          'object-src': ["'none'"],
        },
      },
    }),
  );

  // The only body parser, deliberately. A cross-origin HTML form cannot produce
  // application/json, so adding express.urlencoded() here would quietly remove
  // one of the three CSRF controls.
  app.use(express.json());

  // Cookies became an ambient credential the moment C1 landed, so every
  // state-changing request gets its Origin checked.
  app.use(requireSameOrigin);

  app.use(express.static('web'));

  // Login and refresh cannot require a valid access token; the rest of the API
  // is closed by default.
  app.use('/api/auth', authRouter);
  app.use('/api/conversations', authenticate, conversationsRouter);
  app.use('/api/messages', authenticate, messagesRouter);
  app.use('/api/search', authenticate, searchRouter);

  // Must be last: Express only treats a four-argument handler as error
  // middleware if every route is already mounted above it.
  app.use(errorHandler);

  return app;
}
