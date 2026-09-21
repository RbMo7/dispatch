import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

import { config } from '../config.js';
import * as schema from './schema.js';

const queryClient = postgres(config.databaseUrl);

export const db = drizzle(queryClient, { schema });
