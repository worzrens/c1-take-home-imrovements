import http from 'node:http';
import { config } from './config.ts';
import { waitForMysql } from './db/mysql.ts';
import { connectMongo } from './db/mongo.ts';
import { createApp } from './app.ts';
import { attachWs } from './ws/hub.ts';
import { installProcessHandlers } from './http/errors.ts';

installProcessHandlers();

const app = createApp();
const server = http.createServer(app);
attachWs(server);

await waitForMysql();
await connectMongo();

server.listen(config.port, () => {
  console.log(`relay listening on :${config.port}`);
});
