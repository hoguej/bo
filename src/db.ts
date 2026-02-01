/**
 * PostgreSQL database layer with family-based multi-tenancy
 * Replaces bun:sqlite with pg (node-postgres)
 */

import { Pool, PoolClient } from "pg";

let pool: Pool | null = null;

function getPool(): Pool {
  if (pool) return pool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL environment variable not set");
  }

  pool = new Pool({
    connectionString,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
  });

  return pool;
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

// ============================================================================
// FAMILY CONTEXT HELPERS
// ============================================================================

/**
 * Get family ID from Telegram context (group chat or DM)
 */
export async function getFamilyFromTelegramContext(chatId: string | number, userId: number): Promise<number> {
  const pool = getPool();
  
  // If it's a group chat, look up family by chat_id
  if (typeof chatId === 'number' && chatId < 0) {
    const result = await pool.query(
      'SELECT family_id FROM group_chats WHERE chat_id = $1',
      [chatId.toString()]
    );
    if (result.rows[0]) {
      return result.rows[0].family_id;
    }
  }

  // DM: use user's last_active_family_id
  const result = await pool.query(
    'SELECT last_active_family_id FROM users WHERE id = $1',
    [userId]
  );
  
  if (result.rows[0]?.last_active_family_id) {
    return result.rows[0].last_active_family_id;
  }

  // Fallback: get user's first family
  const fallback = await pool.query(
    'SELECT family_id FROM family_memberships WHERE user_id = $1 LIMIT 1',
    [userId]
  );
  
  if (fallback.rows[0]) {
    return fallback.rows[0].family_id;
  }

  throw new Error(`User ${userId} has no family memberships`);
}

/**
 * Update user's last active family
 */
export async function updateLastActiveFamily(userId: number, familyId: number): Promise<void> {
  const pool = getPool();
  await pool.query(
    'UPDATE users SET last_active_family_id = $1, updated_at = NOW() WHERE id = $2',
    [familyId, userId]
  );
}

/**
 * Check if user has access to family
 */
export async function userHasAccessToFamily(userId: number, familyId: number): Promise<boolean> {
  const pool = getPool();
  const result = await pool.query(
    'SELECT 1 FROM family_memberships WHERE user_id = $1 AND family_id = $2',
    [userId, familyId]
  );
  return result.rows.length > 0;
}

/**
 * Get user's role in family
 */
export async function getUserRoleInFamily(userId: number, familyId: number): Promise<'owner' | 'manager' | 'member' | null> {
  const pool = getPool();
  const result = await pool.query(
    'SELECT role FROM family_memberships WHERE user_id = $1 AND family_id = $2',
    [userId, familyId]
  );
  return result.rows[0]?.role || null;
}

// ============================================================================
// USERS
// ============================================================================

export async function dbGetUserIdByTelegramId(telegramId: string): Promise<number | undefined> {
  const pool = getPool();
  const result = await pool.query(
    'SELECT id FROM users WHERE telegram_id = $1',
    [telegramId]
  );
  return result.rows[0]?.id;
}

export async function dbGetUserById(id: number) {
  const pool = getPool();
  const result = await pool.query(
    'SELECT id, first_name, last_name, phone_number, telegram_id, timezone_iana FROM users WHERE id = $1',
    [id]
  );
  return result.rows[0] || null;
}

export async function dbGetAllUsers() {
  const pool = getPool();
  const result = await pool.query(
    'SELECT id, first_name, last_name, phone_number, telegram_id FROM users ORDER BY last_name, first_name'
  );
  return result.rows;
}

// ============================================================================
// FACTS
// ============================================================================

export async function dbGetFacts(userId: number, familyId: number) {
  const pool = getPool();
  const result = await pool.query(
    `SELECT key, value, scope, tags, created_at AS "createdAt", updated_at AS "updatedAt"
     FROM facts
     WHERE (user_id = $1 AND family_id = $2) OR (scope = 'global')
     ORDER BY created_at DESC`,
    [userId, familyId]
  );
  return result.rows.map(row => ({
    ...row,
    tags: typeof row.tags === 'string' ? JSON.parse(row.tags) : row.tags
  }));
}

export async function dbUpsertFact(
  userId: number,
  familyId: number,
  key: string,
  value: string,
  scope: string,
  tags: string[]
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO facts (user_id, family_id, key, value, scope, tags, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
     ON CONFLICT (user_id, family_id, key, scope)
     DO UPDATE SET value = $4, tags = $6, updated_at = NOW()`,
    [userId, familyId, key, value, scope, JSON.stringify(tags)]
  );
}

export async function dbDeleteFact(userId: number, familyId: number, key: string, scope: string): Promise<boolean> {
  const pool = getPool();
  const result = await pool.query(
    'DELETE FROM facts WHERE user_id = $1 AND family_id = $2 AND key = $3 AND scope = $4',
    [userId, familyId, key, scope]
  );
  return (result.rowCount || 0) > 0;
}

// ============================================================================
// CONVERSATION
// ============================================================================

export async function dbGetConversation(userId: number, familyId: number, max: number) {
  const pool = getPool();
  const result = await pool.query(
    `SELECT role, content
     FROM conversation
     WHERE user_id = $1 AND family_id = $2
     ORDER BY seq DESC
     LIMIT $3`,
    [userId, familyId, max]
  );
  return result.rows.reverse();
}

export async function dbAppendConversation(
  userId: number,
  familyId: number,
  userContent: string,
  assistantContent: string,
  maxMessages: number
): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Get next sequence number
    const seqResult = await client.query(
      'SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM conversation WHERE user_id = $1 AND family_id = $2',
      [userId, familyId]
    );
    const seq = seqResult.rows[0].next_seq;

    // Insert user message
    await client.query(
      `INSERT INTO conversation (user_id, family_id, seq, role, content, created_at)
       VALUES ($1, $2, $3, 'user', $4, NOW())`,
      [userId, familyId, seq, userContent.trim()]
    );

    // Insert assistant message
    await client.query(
      `INSERT INTO conversation (user_id, family_id, seq, role, content, created_at)
       VALUES ($1, $2, $3, 'assistant', $4, NOW())`,
      [userId, familyId, seq + 1, assistantContent.trim()]
    );

    // Trim old messages
    const countResult = await client.query(
      'SELECT COUNT(*) AS count FROM conversation WHERE user_id = $1 AND family_id = $2',
      [userId, familyId]
    );
    const count = parseInt(countResult.rows[0].count);

    if (count > maxMessages) {
      const toDelete = count - maxMessages;
      await client.query(
        `DELETE FROM conversation
         WHERE user_id = $1 AND family_id = $2
         AND seq IN (
           SELECT seq FROM conversation
           WHERE user_id = $1 AND family_id = $2
           ORDER BY seq ASC
           LIMIT $3
         )`,
        [userId, familyId, toDelete]
      );
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// ============================================================================
// SUMMARY
// ============================================================================

export async function dbGetSummary(userId: number, familyId: number): Promise<string> {
  const pool = getPool();
  const result = await pool.query(
    'SELECT sentences FROM summary WHERE user_id = $1 AND family_id = $2',
    [userId, familyId]
  );

  if (!result.rows[0]) return "";

  const sentences = result.rows[0].sentences;
  const arr = typeof sentences === 'string' ? JSON.parse(sentences) : sentences;
  return Array.isArray(arr) ? arr.join("\n") : "";
}

export async function dbSetSummary(userId: number, familyId: number, fullSummary: string): Promise<void> {
  const pool = getPool();
  const text = fullSummary.trim().slice(0, 2000);
  await pool.query(
    `INSERT INTO summary (user_id, family_id, sentences, created_at, updated_at)
     VALUES ($1, $2, $3, NOW(), NOW())
     ON CONFLICT (user_id, family_id)
     DO UPDATE SET sentences = $3, updated_at = NOW()`,
    [userId, familyId, JSON.stringify([text])]
  );
}

export async function dbAppendSummarySentence(userId: number, familyId: number, sentence: string): Promise<void> {
  const pool = getPool();
  const s = sentence.trim();
  if (!s) return;

  const result = await pool.query(
    'SELECT sentences FROM summary WHERE user_id = $1 AND family_id = $2',
    [userId, familyId]
  );

  let sentences: string[] = [];
  if (result.rows[0]) {
    const raw = result.rows[0].sentences;
    sentences = typeof raw === 'string' ? JSON.parse(raw) : raw;
  }

  sentences.push(s);
  const trimmed = sentences.length > 50 ? sentences.slice(-50) : sentences;

  await pool.query(
    `INSERT INTO summary (user_id, family_id, sentences, created_at, updated_at)
     VALUES ($1, $2, $3, NOW(), NOW())
     ON CONFLICT (user_id, family_id)
     DO UPDATE SET sentences = $3, updated_at = NOW()`,
    [userId, familyId, JSON.stringify(trimmed)]
  );
}

// ============================================================================
// PERSONALITY
// ============================================================================

export async function dbGetPersonality(userId: number, familyId: number): Promise<string> {
  const pool = getPool();
  const result = await pool.query(
    'SELECT instructions FROM user_personalities WHERE user_id = $1 AND family_id = $2',
    [userId, familyId]
  );

  if (!result.rows[0]) return "";

  const instructions = result.rows[0].instructions;
  const arr = typeof instructions === 'string' ? JSON.parse(instructions) : instructions;
  return Array.isArray(arr) ? arr.join(". ") : "";
}

export async function dbAppendPersonalityInstruction(userId: number, familyId: number, instruction: string): Promise<void> {
  const pool = getPool();
  const raw = instruction.trim();
  if (!raw) return;

  const toAdd = raw.includes(". ") ? raw.split(/\.\s+/).map(s => s.trim()).filter(Boolean) : [raw];

  const result = await pool.query(
    'SELECT instructions FROM user_personalities WHERE user_id = $1 AND family_id = $2',
    [userId, familyId]
  );

  let instructions: string[] = [];
  if (result.rows[0]) {
    const raw = result.rows[0].instructions;
    instructions = typeof raw === 'string' ? JSON.parse(raw) : raw;
  }

  let changed = false;
  for (const s of toAdd) {
    if (s && !instructions.includes(s)) {
      instructions.push(s);
      changed = true;
    }
  }

  if (!changed) return;

  const trimmed = instructions.length > 20 ? instructions.slice(-20) : instructions;

  await pool.query(
    `INSERT INTO user_personalities (user_id, family_id, instructions, created_at, updated_at)
     VALUES ($1, $2, $3, NOW(), NOW())
     ON CONFLICT (user_id, family_id)
     DO UPDATE SET instructions = $3, updated_at = NOW()`,
    [userId, familyId, JSON.stringify(trimmed)]
  );
}

// ============================================================================
// TODOS
// ============================================================================

export interface TodoRow {
  id: number;
  text: string;
  done: boolean;
  createdAt: string;
  creator_user_id: number | null;
}

export async function dbGetTodos(userId: number, familyId: number, opts?: { includeDone?: boolean }): Promise<TodoRow[]> {
  const pool = getPool();
  const includeDone = opts?.includeDone === true;
  
  const query = includeDone
    ? 'SELECT id, text, done, created_at AS "createdAt", creator_user_id FROM todos WHERE user_id = $1 AND family_id = $2 ORDER BY id ASC'
    : 'SELECT id, text, done, created_at AS "createdAt", creator_user_id FROM todos WHERE user_id = $1 AND family_id = $2 AND done = false ORDER BY id ASC';

  const result = await pool.query(query, [userId, familyId]);
  return result.rows;
}

export async function dbAddTodo(userId: number, familyId: number, text: string, creatorUserId?: number): Promise<number | undefined> {
  const pool = getPool();
  const result = await pool.query(
    `INSERT INTO todos (user_id, family_id, creator_user_id, text, done, created_at)
     VALUES ($1, $2, $3, $4, false, NOW())
     RETURNING id`,
    [userId, familyId, creatorUserId || userId, text]
  );
  return result.rows[0]?.id;
}

export async function dbUpdateTodoDone(userId: number, familyId: number, id: number): Promise<boolean> {
  const pool = getPool();
  const result = await pool.query(
    'UPDATE todos SET done = true WHERE user_id = $1 AND family_id = $2 AND id = $3',
    [userId, familyId, id]
  );
  return (result.rowCount || 0) > 0;
}

export async function dbDeleteTodo(userId: number, familyId: number, id: number): Promise<boolean> {
  const pool = getPool();
  const result = await pool.query(
    'DELETE FROM todos WHERE user_id = $1 AND family_id = $2 AND id = $3',
    [userId, familyId, id]
  );
  return (result.rowCount || 0) > 0;
}

export async function dbUpdateTodoText(userId: number, familyId: number, id: number, text: string): Promise<boolean> {
  const pool = getPool();
  const result = await pool.query(
    'UPDATE todos SET text = $1 WHERE user_id = $2 AND family_id = $3 AND id = $4',
    [text, userId, familyId, id]
  );
  return (result.rowCount || 0) > 0;
}

// ============================================================================
// LLM LOG
// ============================================================================

export async function dbInsertLlmLog(
  requestId: string,
  userId: number | null,
  familyId: number | null,
  step: string,
  requestDoc: unknown,
  responseText: string
): Promise<void> {
  const pool = getPool();
  const request_doc = typeof requestDoc === 'string' ? requestDoc : JSON.stringify(requestDoc);
  
  await pool.query(
    `INSERT INTO llm_log (request_id, user_id, family_id, owner, step, request_doc, response_text, created_at)
     VALUES ($1, $2, $3, 'default', $4, $5, $6, NOW())`,
    [requestId, userId, familyId, step, request_doc, responseText || ""]
  );
}

// ============================================================================
// MODERATION FLAGS
// ============================================================================

export async function dbLogModerationFlag(data: {
  userId: number;
  familyId: number;
  message: string;
  originalResponse?: string;
  replacementResponse?: string;
  flags: Record<string, any>;
  action: 'blocked' | 'replaced' | 'flagged';
}): Promise<number> {
  const pool = getPool();
  const result = await pool.query(
    `INSERT INTO moderation_flags (user_id, family_id, message, original_response, replacement_response, flags, action, reviewed, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, false, NOW())
     RETURNING id`,
    [
      data.userId,
      data.familyId,
      data.message,
      data.originalResponse || null,
      data.replacementResponse || null,
      JSON.stringify(data.flags),
      data.action
    ]
  );
  return result.rows[0].id;
}

// ============================================================================
// RATE LIMITING
// ============================================================================

export async function dbLogRateLimitViolation(data: {
  familyId: number;
  userId?: number;
  messageCount: number;
  windowStart: Date;
  windowEnd: Date;
  cooldownUntil?: Date;
  cooldownLevel: number;
}): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO rate_limit_log (family_id, user_id, message_count, window_start, window_end, cooldown_until, cooldown_level, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
    [
      data.familyId,
      data.userId || null,
      data.messageCount,
      data.windowStart,
      data.windowEnd,
      data.cooldownUntil || null,
      data.cooldownLevel
    ]
  );
}

// ============================================================================
// CONFIG
// ============================================================================

export async function dbGetConfig(key: string): Promise<string | undefined> {
  const pool = getPool();
  const result = await pool.query(
    'SELECT value FROM config WHERE key = $1',
    [key]
  );
  return result.rows[0]?.value;
}

export async function dbSetConfig(key: string, value: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO config (key, value)
     VALUES ($1, $2)
     ON CONFLICT (key)
     DO UPDATE SET value = $2`,
    [key, value]
  );
}

// ============================================================================
// SCHEDULE STATE
// ============================================================================

export async function dbUpdateLastConvoEndUtc(userId: number): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO schedule_state (user_id, last_convo_end_utc)
     VALUES ($1, NOW())
     ON CONFLICT (user_id)
     DO UPDATE SET last_convo_end_utc = NOW()`,
    [userId]
  );
}

export async function dbGetUserTimezone(userId: number): Promise<string> {
  const pool = getPool();
  const result = await pool.query(
    'SELECT timezone_iana FROM users WHERE id = $1',
    [userId]
  );
  return result.rows[0]?.timezone_iana || "America/New_York";
}

// Additional functions for compatibility with watch-self
export async function dbGetPrimaryUserPhone(): Promise<string | undefined> {
  const pool = getPool();
  const result = await pool.query('SELECT phone_number FROM users WHERE is_system_admin = TRUE LIMIT 1');
  return result.rows[0]?.phone_number;
}

export async function dbGetPhoneNumbersThatCanTriggerAgent(): Promise<string[]> {
  const pool = getPool();
  const result = await pool.query('SELECT phone_number FROM users WHERE can_trigger_agent = TRUE');
  return result.rows.map((r: any) => r.phone_number);
}

export async function dbHasRepliedToMessage(guid: string): Promise<boolean> {
  const pool = getPool();
  const result = await pool.query('SELECT 1 FROM watch_self_replied WHERE guid = $1', [guid]);
  return result.rows.length > 0;
}

export async function dbMarkMessageReplied(guid: string): Promise<void> {
  const pool = getPool();
  await pool.query('INSERT INTO watch_self_replied (guid, replied_at_utc) VALUES ($1, NOW()) ON CONFLICT (guid) DO NOTHING', [guid]);
}

export async function dbResolveOwnerToUserId(owner: string): Promise<number | undefined> {
  const pool = getPool();
  const result = await pool.query('SELECT id FROM users WHERE phone_number = $1', [owner]);
  return result.rows[0]?.id;
}

export async function dbGetOwnerByUserId(userId: number): Promise<string> {
  const pool = getPool();
  const result = await pool.query('SELECT phone_number FROM users WHERE id = $1', [userId]);
  return result.rows[0]?.phone_number || '';
}

export async function dbGetScheduleState(userId: number): Promise<any> {
  const pool = getPool();
  const result = await pool.query('SELECT * FROM schedule_state WHERE user_id = $1', [userId]);
  return result.rows[0] || null;
}

export async function dbUpsertScheduleState(userId: number, state: any): Promise<void> {
  const pool = getPool();
  await pool.query(`
    INSERT INTO schedule_state (user_id, last_daily_reminder_utc)
    VALUES ($1, $2)
    ON CONFLICT (user_id) DO UPDATE SET last_daily_reminder_utc = $2
  `, [userId, state.last_daily_reminder_utc]);
}

export async function dbGetDueReminders(nowIso: string): Promise<any[]> {
  const pool = getPool();
  const result = await pool.query(`
    SELECT * FROM reminders 
    WHERE fire_at_utc <= $1 AND sent_at_utc IS NULL
  `, [nowIso]);
  return result.rows;
}

export async function dbMarkReminderSentOneOff(id: number): Promise<void> {
  const pool = getPool();
  await pool.query('UPDATE reminders SET sent_at_utc = NOW() WHERE id = $1', [id]);
}

export async function dbAdvanceRecurringReminder(id: number, nextFireAtUtc: string): Promise<void> {
  const pool = getPool();
  await pool.query('UPDATE reminders SET next_fire_at_utc = $1, fire_at_utc = $1 WHERE id = $2', [nextFireAtUtc, id]);
}

export async function dbUpsertGroupChat(chatId: string, name: string, type: string): Promise<void> {
  const pool = getPool();
  await pool.query(`
    INSERT INTO group_chats (chat_id, name, type, family_id)
    VALUES ($1, $2, $3, 1)
    ON CONFLICT (chat_id) DO UPDATE SET name = $2, type = $3
  `, [chatId, name, type]);
}

export async function dbGetGroupChatByName(name: string): Promise<any> {
  const pool = getPool();
  const result = await pool.query('SELECT * FROM group_chats WHERE name = $1 LIMIT 1', [name]);
  return result.rows[0] || null;
}

// Contact helper functions for watch-self
export async function dbGetContactsNumberToName(): Promise<Map<string, string>> {
  const pool = getPool();
  const result = await pool.query('SELECT phone_number, first_name, last_name FROM users');
  const map = new Map<string, string>();
  for (const row of result.rows) {
    const name = `${row.first_name}${row.last_name ? ' ' + row.last_name : ''}`;
    map.set(row.phone_number, name);
  }
  return map;
}

export async function dbGetContactsNameToNumber(): Promise<Map<string, string>> {
  const pool = getPool();
  const result = await pool.query('SELECT phone_number, first_name, last_name FROM users');
  const map = new Map<string, string>();
  for (const row of result.rows) {
    const name = `${row.first_name}${row.last_name ? ' ' + row.last_name : ''}`;
    map.set(name.toLowerCase(), row.phone_number);
  }
  return map;
}

export async function dbGetContactsList(): Promise<Array<{ name: string; number: string }>> {
  const pool = getPool();
  const result = await pool.query('SELECT phone_number, first_name, last_name FROM users ORDER BY first_name');
  return result.rows.map((row: any) => ({
    name: `${row.first_name}${row.last_name ? ' ' + row.last_name : ''}`,
    number: row.phone_number,
  }));
}

export async function dbGetTelegramIdByPhone(phone: string): Promise<string | undefined> {
  const pool = getPool();
  const result = await pool.query('SELECT telegram_id FROM users WHERE phone_number = $1', [phone]);
  return result.rows[0]?.telegram_id;
}
