export const config = {
  port: Number(process.env.PORT) || 3000,
  mysqlUrl: process.env.MYSQL_URL || 'mysql://root:root@mysql:3306/relay?charset=utf8mb4',
  mongoUrl: process.env.MONGO_URL || 'mongodb://mongo:27017/relay',
  redisUrl: process.env.REDIS_URL || 'redis://redis:6379',
  // No fallback on purpose. A default signing key is a published signing key,
  // and every deployment that forgot to set one would share it. Validated in
  // src/auth/tokens.ts, which src/index.ts calls at boot so this fails loudly at
  // startup rather than on the first login.
  jwtSecret: process.env.JWT_SECRET || '',
};
