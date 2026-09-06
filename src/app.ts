import express from 'express';
import helmet from 'helmet';
import { conversationsRouter } from './routes/conversations.js';
import { messagesRouter } from './routes/messages.js';
import { searchRouter } from './routes/search.js';
import { errorHandler } from './http/errors.ts';

/**
 * Builds the Express app with every route and middleware mounted, but without
 * touching MySQL, Mongo or the WebSocket. `src/index.ts` wires those in and
 * starts listening; the tests import this directly and run it on an ephemeral
 * port with no database connection.
 */
export function createApp() {
  const app = express();

  // Express advertises itself in a response header by default. It tells an
  // attacker what to look up and tells a user nothing.
  app.disable('x-powered-by');

  // The page loads only its own script and stylesheet, so the policy can be strict.
  // The inline <style> block was moved to web/styles.css for exactly this reason:
  // keeping it would have forced 'unsafe-inline' on style-src and weakened the
  // policy for the sake of one block of CSS.
  //
  // 'self' in connect-src covers the same-origin WebSocket. If a browser ever
  // blocks the socket, this directive is the first place to look.
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

  app.use(express.json());
  app.use(express.static('web'));
  app.use('/api/conversations', conversationsRouter);
  app.use('/api/messages', messagesRouter);
  app.use('/api/search', searchRouter);

  // Must be last: Express only treats a four-argument handler as error middleware
  // if every route is already mounted above it.
  app.use(errorHandler);

  return app;
}
