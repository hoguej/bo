/**
 * Database wrapper - auto-detects PostgreSQL or falls back to SQLite
 * If DATABASE_URL is set, uses PostgreSQL (async)
 * Otherwise uses SQLite (sync, but wrapped in Promise for compatibility)
 */

// Check if we should use PostgreSQL
const usePostgres = !!process.env.DATABASE_URL;

if (usePostgres) {
  // Re-export all functions from db-pg.ts (async PostgreSQL)
  export * from './db-pg';
  console.error('[db] Using PostgreSQL (async)');
} else {
  // Re-export all functions from db.ts (sync SQLite, wrapped as async)
  const sqlite = require('./db-sqlite-backup');
  
  // For now, just error out if PostgreSQL is not available on Railway
  if (process.env.RAILWAY_ENVIRONMENT) {
    throw new Error('DATABASE_URL must be set on Railway');
  }
  
  // Wrap sync SQLite functions to be async-compatible
  // (This is for local development only)
  module.exports = new Proxy(sqlite, {
    get(target, prop) {
      const value = target[prop];
      if (typeof value === 'function') {
        // Wrap sync function to return Promise
        return (...args: any[]) => Promise.resolve(value(...args));
      }
      return value;
    }
  });
  console.error('[db] Using SQLite (sync wrapped as async)');
}
