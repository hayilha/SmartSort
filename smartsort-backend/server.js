/**
 * ============================================================================
 * SmartSort Backend API Gateway Server (server.js)
 * ============================================================================
 * Core entry point for the SmartSort Express REST API service.
 * 
 * Responsibilities:
 *  1. Network Configuration: Forces IPv4 resolution for reliable cloud DB access.
 *  2. Application Monitoring: Initializes Sentry instrumentation before all modules.
 *  3. Environment Validation: Guards that required secrets/URLs exist at boot.
 *  4. Global Middleware: Enforces request IDs, logging, CORS, and payload limits.
 *  5. Background Schedulers: Boots automated cron workers (full-bin checks, offline probes).
 *  6. Health Probes: Exposes live database connectivity check (/health).
 *  7. Routing: Mounts versioned API endpoints under /api.
 *  8. Process Resilience: Catches unhandled rejections and uncaught exceptions gracefully.
 */

const dns = require('dns');

// ── 1. Network / DNS Configuration ──────────────────────────────────────────
// Some cloud hosts (e.g., Supabase, AWS) may fail or hang if Node attempts IPv6 resolution
// on networks without proper dual-stack IPv6 routing. Setting 'ipv4first' guarantees fast,
// deterministic DNS resolution for PostgreSQL and Supabase APIs.
if (dns.setDefaultResultOrder) {
  dns.setDefaultResultOrder('ipv4first');
}

// ── 2. Performance Monitoring & Crash Telemetry ──────────────────────────────
// IMPORTANT: instrument.js must be imported before any other package (including express)
// so that Sentry can monkey-patch Node.js HTTP/HTTPS modules for distributed tracing.
const Sentry = require('./instrument');
const express = require('express');
const cors = require('cors');

// ── 3. Startup Environment Variable Sanity Check ─────────────────────────────
// Fail fast: Prevent the server from starting in an invalid state if critical credentials
// (Postgres connection string, Supabase API keys) are missing.
const requiredEnvVars = ['DATABASE_URL', 'SUPABASE_URL', 'SUPABASE_ANON_KEY'];
requiredEnvVars.forEach((varName) => {
  if (!process.env[varName]) {
    console.error(`FATAL ERROR: Environment variable ${varName} is missing.`);
    process.exit(1);
  }
});

// Internal dependencies & middlewares
const { requestId } = require('./middleware/requestId');
const { requestLogger } = require('./middleware/logging');
const { errorHandler } = require('./middleware/errorHandler');
const routes = require('./routes');
const logger = require('./utils/logger');
const { prisma } = require('./lib/prisma');

// Initialize the Express web application instance
const app = express();

// ── 4. Background Scheduled Tasks (Cron Jobs) ───────────────────────────────
// offlineCheck: Periodically pings device timestamps and flags silent bins as 'Offline'.
// autoScheduleCron: Periodically detects bins >= 80% full and creates pickup jobs automatically.
require('./cron/offlineCheck');
require('./cron/autoScheduleCron');

// ── 5. Global Middleware Pipeline ───────────────────────────────────────────
// Assigns a unique UUID (X-Request-Id) to incoming HTTP requests for end-to-end tracing.
app.use(requestId);

// Formats and logs HTTP traffic (method, route, response status, duration in ms) via Winston.
app.use(requestLogger);

// Cross-Origin Resource Sharing (CORS) to allow browser dashboard requests from frontend origins.
app.use(cors());

// Parse incoming JSON payloads with a generous 50mb ceiling (needed for Base64 camera image uploads).
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// ── 6. Health & Diagnostics Endpoints ────────────────────────────────────────
/**
 * GET /health
 * Liveness and readiness probe for load balancers, orchestrators, and monitoring services.
 * Tests active PostgreSQL connectivity via Prisma raw query.
 */
app.get('/health', async (req, res) => {
  try {
    // Quick, non-blocking DB heartbeat query
    await prisma.$queryRaw`SELECT 1`;

    res.status(200).json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      database: 'connected',
      version: '1.0.0',
    });
  } catch (err) {
    // 503 Service Unavailable signals orchestrators that the server cannot reach the DB
    res.status(503).json({
      status: 'error',
      database: 'disconnected',
      error: err.message,
    });
  }
});

/**
 * GET /debug-sentry
 * Intentional exception trigger to test and verify Sentry error alerting in staging/production.
 */
app.get("/debug-sentry", function mainHandler(req, res) {
  throw new Error("My first Sentry error!");
});

// ── 7. Primary API Router ───────────────────────────────────────────────────
// Mount all versioned API routes (auth, bins, devices, jobs, analytics, route optimization) under /api
app.use('/api', routes);

// ── 8. Error Handling Pipeline ──────────────────────────────────────────────
// Sentry error handler captures unhandled route exceptions before passing to our custom handler
Sentry.setupExpressErrorHandler(app);

// Custom centralized error handler that structures client responses and scrubs sensitive stack traces
app.use(errorHandler);

// ── 9. Server Initialization ────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  logger.info(`Server is running on http://localhost:${PORT}`);
});

// ── 10. Process Level Safety Nets ───────────────────────────────────────────
// Catches unhandled asynchronous promise rejections to prevent silent node crashes
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Promise Rejection:', { reason: reason?.message || reason, stack: reason?.stack });
});

// Catches unhandled synchronous exceptions, logs the crash, and terminates safely
process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception:', { message: err.message, stack: err.stack });
  // Allow Winston file streams time to flush buffers before killing the process
  setTimeout(() => process.exit(1), 1000);
});

// Export app for unit/integration testing (Supertest)
module.exports = app;