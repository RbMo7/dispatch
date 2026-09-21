export const config = {
  port: Number(process.env.PORT ?? 8420),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://dispatch:dispatch@localhost:5432/dispatch',
};
