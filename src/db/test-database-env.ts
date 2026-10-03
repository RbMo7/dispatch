import { inject } from 'vitest';

// Runs before each test file imports src/config.ts, which reads this.
process.env.DATABASE_URL = inject('testDatabaseUrl');
