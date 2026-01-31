/**
 * Redis-based rate limiting with escalating cooldowns
 * 
 * Rate limit: 4 messages per minute per family member
 * Rolling 15-minute window
 * Escalating cooldowns: 30s, 60s, 120s, 240s, 10m, 30m, 60m
 */

import Redis from "ioredis";
import { dbLogRateLimitViolation } from "./db-pg";

let redis: Redis | null = null;

function getRedis(): Redis {
  if (redis) return redis;

  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error("REDIS_URL environment variable not set");
  }

  redis = new Redis(redisUrl, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: false,
  });

  redis.on('error', (err) => {
    console.error('[Redis Error]', err);
  });

  return redis;
}

export async function closeRedis(): Promise<void> {
  if (redis) {
    await redis.quit();
    redis = null;
  }
}

/**
 * Cooldown levels in seconds
 */
const COOLDOWN_LEVELS = [
  30,    // Level 0: 30 seconds
  60,    // Level 1: 1 minute
  120,   // Level 2: 2 minutes
  240,   // Level 3: 4 minutes
  600,   // Level 4: 10 minutes
  1800,  // Level 5: 30 minutes
  3600,  // Level 6: 1 hour
];

export interface RateLimitResult {
  allowed: boolean;
  reason?: 'rate_limit_exceeded' | 'in_cooldown';
  messageCount?: number;
  limit?: number;
  cooldownUntil?: Date;
  cooldownLevel?: number;
}

/**
 * Check rate limit for a family
 * 
 * @param familyId - Family ID
 * @param memberCount - Number of family members (for calculating limit)
 * @returns Rate limit check result
 */
export async function checkRateLimit(familyId: number, memberCount: number): Promise<RateLimitResult> {
  const redis = getRedis();
  const now = Date.now();
  
  // Keys
  const cooldownKey = `ratelimit:family:${familyId}:cooldown`;
  const levelKey = `ratelimit:family:${familyId}:level`;
  const messagesKey = `ratelimit:family:${familyId}:messages`;
  
  // Check if in cooldown
  const cooldownUntilStr = await redis.get(cooldownKey);
  if (cooldownUntilStr) {
    const cooldownUntil = parseInt(cooldownUntilStr);
    if (now < cooldownUntil) {
      const levelStr = await redis.get(levelKey);
      const level = levelStr ? parseInt(levelStr) : 0;
      
      return {
        allowed: false,
        reason: 'in_cooldown',
        cooldownUntil: new Date(cooldownUntil),
        cooldownLevel: level,
      };
    } else {
      // Cooldown expired, reset level if behavior improved
      await redis.del(cooldownKey);
      // Optionally decrement level after cooldown expires
      const levelStr = await redis.get(levelKey);
      if (levelStr) {
        const level = parseInt(levelStr);
        if (level > 0) {
          await redis.set(levelKey, level - 1, 'EX', 86400); // Decay level after 24h
        }
      }
    }
  }

  // Calculate limit: 4 messages per minute per family member
  // Over 15 minutes: 60 messages per member
  const limit = memberCount * 60; // 4 msg/min * 15 min * member_count
  const windowMs = 15 * 60 * 1000; // 15 minutes
  const windowStart = now - windowMs;

  // Add current timestamp to sorted set
  await redis.zadd(messagesKey, now, `${now}`);

  // Remove old entries (outside 15-min window)
  await redis.zremrangebyscore(messagesKey, 0, windowStart);

  // Count messages in window
  const messageCount = await redis.zcount(messagesKey, windowStart, now);

  // Set expiry on messages key (cleanup)
  await redis.expire(messagesKey, 900); // 15 minutes

  // Check if limit exceeded
  if (messageCount > limit) {
    // Get current cooldown level
    const levelStr = await redis.get(levelKey);
    const currentLevel = levelStr ? parseInt(levelStr) : 0;
    const nextLevel = Math.min(currentLevel + 1, COOLDOWN_LEVELS.length - 1);
    const cooldownSeconds = COOLDOWN_LEVELS[nextLevel];
    const cooldownUntil = now + (cooldownSeconds * 1000);

    // Set cooldown
    await redis.set(cooldownKey, cooldownUntil, 'EX', cooldownSeconds);
    await redis.set(levelKey, nextLevel, 'EX', 86400); // Level persists for 24h

    // Reset message counter
    await redis.del(messagesKey);

    // Log violation
    await dbLogRateLimitViolation({
      familyId,
      messageCount,
      windowStart: new Date(windowStart),
      windowEnd: new Date(now),
      cooldownUntil: new Date(cooldownUntil),
      cooldownLevel: nextLevel,
    });

    return {
      allowed: false,
      reason: 'rate_limit_exceeded',
      messageCount,
      limit,
      cooldownUntil: new Date(cooldownUntil),
      cooldownLevel: nextLevel,
    };
  }

  return {
    allowed: true,
    messageCount,
    limit,
  };
}

/**
 * Generate personality-appropriate cooldown message
 */
export async function generateCooldownMessage(
  userId: number,
  familyId: number,
  cooldownLevel: number
): Promise<string> {
  // Default messages by level
  const defaultMessages = [
    "Whew! I need a quick breather. Give me 30 seconds!",
    "Taking a short break—back in a minute!",
    "Need to rest my brain for a couple minutes!",
    "Woah, that was intense! Be back in 4 minutes.",
    "I'm exhausted! Taking a 10-minute break.",
    "Really need to recharge. Back in 30 minutes!",
    "Taking an hour break—I'll be fresh when I return!",
  ];

  // TODO: Load user personality and generate custom message
  // For now, use defaults
  return defaultMessages[Math.min(cooldownLevel, defaultMessages.length - 1)];
}

/**
 * Record a message attempt during cooldown (for logging)
 */
export async function logCooldownAttempt(familyId: number, userId?: number): Promise<void> {
  const redis = getRedis();
  const attemptKey = `ratelimit:family:${familyId}:attempts`;
  await redis.incr(attemptKey);
  await redis.expire(attemptKey, 900); // 15 minutes

  // Could log to database if needed for admin review
  console.log(`[Rate Limit] Family ${familyId} attempted message during cooldown`);
}
