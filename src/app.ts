import express from 'express';
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
