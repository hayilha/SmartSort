/**
 * ============================================================================
 * Database Client & Connection Pool Configuration (lib/prisma.js)
 * ============================================================================
 * Initializes and exports the singleton PrismaClient instance paired with a
 * node-postgres (pg.Pool) connection pool adapter.
 *
 * Key Architecture Decisions:
 *  1. Connection Pooling: Managed cloud databases (such as Supabase PostgreSQL)
 *     impose strict concurrent connection limits (e.g. 15 direct connections).
 *     Configuring `max: 5` ensures the backend never exhausts the database pool.
 *  2. SSL Configuration: Cloud hosts require encrypted connections. Self-signed
 *     or intermediate certificates are permitted via `rejectUnauthorized: false`.
 *  3. Process Lifecycle Hooks: On SIGINT (Ctrl+C) or SIGUSR2 (Nodemon reloads),
 *     active connections are cleanly drained and closed to prevent connection leaks.
 */

const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');
const logger = require('../utils/logger');

const databaseUrl = process.env.DATABASE_URL;

// Determine if connecting to Supabase cloud to conditionally apply SSL certificates
const isSupabaseDatabase = /supabase\.com/i.test(databaseUrl || '');

/**
 * PostgreSQL Connection Pool via 'pg'
 * Manages physical TCP sockets to the PostgreSQL database.
 */
const pool = new Pool({
  connectionString: databaseUrl,
  // Enable SSL with flexible certificate validation when connecting to cloud Supabase
  ssl: isSupabaseDatabase ? { rejectUnauthorized: false } : undefined,
  // Maximum active connections allowed in the pool
  max: 5,
  // Close idle clients after 30 seconds of inactivity
  idleTimeoutMillis: 30000,
  // Abort connection attempt if database does not respond within 15 seconds
  connectionTimeoutMillis: 15000,
});

/**
 * Prisma Client Instance
 * Powered by the PrismaPg adapter for fast, low-overhead query serialization.
 */
const prisma = new PrismaClient({
  adapter: new PrismaPg(pool),
  log: [
    { emit: 'event', level: 'warn' },
    { emit: 'event', level: 'error' },
  ],
});

// ── Lifecycle Shutdown Hooks ────────────────────────────────────────────────
/**
 * SIGUSR2: Triggered by Nodemon during code changes.
 * Drains and closes DB pool to avoid leaving orphaned backend connections.
 */
process.once('SIGUSR2', async () => {
  try {
    await prisma.$disconnect();
    await pool.end();
  } catch (err) {
    logger.error('Error disconnecting prisma/pool on restart:', err);
  } finally {
    if (process.platform === 'win32') {
      process.exit(0);
    } else {
      process.kill(process.pid, 'SIGUSR2');
    }
  }
});

/**
 * SIGINT: Triggered when operator presses Ctrl+C or Docker stops container.
 */
process.on('SIGINT', async () => {
  try {
    await prisma.$disconnect();
    await pool.end();
  } finally {
    process.exit(0);
  }
});

// ── Prisma Event Listeners ──────────────────────────────────────────────────
// Forward internal Prisma engine warnings to the centralized Winston logger
prisma.$on('warn', (e) => {
  logger.warn(`Prisma Warning: ${e.message}`);
});

// Forward internal Prisma engine errors to the centralized Winston logger
prisma.$on('error', (e) => {
  logger.error(`Prisma Error: ${e.message}`);
});

module.exports = { prisma, pool };
