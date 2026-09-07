import http from 'node:http';
import { config } from './config.ts';
import { waitForMysql } from './db/mysql.ts';
import { connectMongo } from './db/mongo.ts';
import { connectRedis } from './db/redis.ts';
import { jwtSecret } from './auth/tokens.ts';
import { createApp } from './app.ts';
import { attachWs } from './ws/hub.ts';
import { installProcessHandlers } from './http/errors.ts';

installProcessHandlers();

// Before anything else: a missing or short JWT_SECRET must stop the process at
// boot, not surface as a 500 on the first login attempt.
jwtSecret();

await waitForMysql();
await connectMongo();
await connectRedis();

const app = createApp();
const server = http.createServer(app);
// After Redis, because the hub subscribes to the fan-out channel as it attaches.
await attachWs(server);

server.listen(config.port, () => {
  console.log(`relay listening on :${config.port}`);
});
