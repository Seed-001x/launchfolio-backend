// src/db/pool.js — shared Postgres pool. Reads DATABASE_URL from env.
import pg from 'pg';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // modest defaults for a starter-tier database
  max: 10,
  idleTimeoutMillis: 30_000,
});

pool.on('error', (err) => {
  console.error('[db] pool error:', err.message);
});
