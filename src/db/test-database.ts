import { randomBytes } from 'node:crypto';

import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import type { TestProject } from 'vitest/node';

import { config } from '../config.js';

declare module 'vitest' {
  export interface ProvidedContext {
    testDatabaseUrl: string;
  }
}

/**
 * Vitest global setup (ADR-0047): the real-Postgres tier runs in a database
 * of its own, created and migrated here and dropped afterwards, so it never
 * reads, truncates or leaves rows in the database DATABASE_URL names.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const name = `dispatch_test_${process.pid}_${randomBytes(4).toString('hex')}`;
  const admin = postgres(config.databaseUrl, { max: 1, onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE "${name}"`);

  const url = new URL(config.databaseUrl);
  url.pathname = `/${name}`;
  const client = postgres(url.href, { max: 1, onnotice: () => {} });
  await migrate(drizzle(client), { migrationsFolder: 'drizzle' });
  await client.end();

  project.provide('testDatabaseUrl', url.href);

  return async () => {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
  };
}
