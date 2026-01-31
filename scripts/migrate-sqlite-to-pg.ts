#!/usr/bin/env bun
/**
 * Migrate SQLite data to PostgreSQL with family-based multi-tenancy
 * 
 * Usage: bun run scripts/migrate-sqlite-to-pg.ts
 */

import { Database } from "bun:sqlite";
import { Client } from "pg";
import { homedir } from "node:os";
import { join } from "node:path";

const SQLITE_PATH = process.env.BO_DB_PATH || join(homedir(), ".bo", "bo.db");
const POSTGRES_URL = process.env.DATABASE_URL;

if (!POSTGRES_URL) {
  console.error("❌ DATABASE_URL environment variable not set");
  process.exit(1);
}

interface User {
  id: number;
  first_name: string;
  last_name: string;
  phone_number: string;
  telegram_id: string | null;
  can_trigger_agent: number;
  timezone_iana: string | null;
}

interface Fact {
  user_id: number;
  key: string;
  value: string;
  scope: string;
  tags: string;
  created_at: string;
  updated_at: string;
}

interface ConversationMessage {
  user_id: number;
  seq: number;
  role: string;
  content: string;
}

interface Summary {
  user_id: number;
  sentences: string;
}

interface Personality {
  user_id: number;
  instructions: string;
}

interface Todo {
  id: number;
  user_id: number;
  creator_user_id: number | null;
  text: string;
  done: number;
  created_at: string;
}

interface Reminder {
  id: number;
  creator_user_id: number;
  recipient_user_id: number;
  text: string;
  kind: string;
  fire_at_utc: string | null;
  recurrence: string | null;
  next_fire_at_utc: string | null;
  created_at: string;
  sent_at: string | null;
  last_fired_at: string | null;
}

async function migrate() {
  console.log("🚀 Starting SQLite → PostgreSQL migration");
  console.log(`📂 SQLite: ${SQLITE_PATH}`);
  console.log(`🔌 PostgreSQL: ${POSTGRES_URL.replace(/:[^:@]+@/, ':****@')}\n`);

  // Open SQLite database
  const sqlite = new Database(SQLITE_PATH, { readonly: true });
  
  // Connect to PostgreSQL
  const pg = new Client({ connectionString: POSTGRES_URL });
  await pg.connect();

  try {
    await pg.query('BEGIN');

    // ========================================================================
    // STEP 1: Create "Hogue Family"
    // ========================================================================
    console.log("👨‍👩‍👧‍👦 Creating Hogue Family...");
    const familyResult = await pg.query(
      `INSERT INTO families (name, created_at, updated_at) 
       VALUES ($1, NOW(), NOW()) 
       RETURNING id`,
      ["Hogue Family"]
    );
    const familyId = familyResult.rows[0].id;
    console.log(`✅ Created family with ID: ${familyId}\n`);

    // ========================================================================
    // STEP 2: Migrate Users
    // ========================================================================
    console.log("👤 Migrating users...");
    const users = sqlite.query("SELECT * FROM users WHERE phone_number != 'default'").all() as User[];
    
    const userIdMap = new Map<number, number>(); // old_id -> new_id
    let primaryUserId: number | null = null;

    for (const user of users) {
      const result = await pg.query(
        `INSERT INTO users (first_name, last_name, phone_number, telegram_id, can_trigger_agent, timezone_iana, last_active_family_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
         RETURNING id`,
        [
          user.first_name || "",
          user.last_name || "",
          user.phone_number,
          user.telegram_id || null,
          user.can_trigger_agent === 1,
          user.timezone_iana || "America/New_York",
          familyId
        ]
      );
      
      const newUserId = result.rows[0].id;
      userIdMap.set(user.id, newUserId);

      // Jon Hogue is the primary user and system admin
      if (user.telegram_id === "8574143544") {
        primaryUserId = newUserId;
        await pg.query('UPDATE users SET is_system_admin = true WHERE id = $1', [newUserId]);
      }

      console.log(`  ✓ ${user.first_name} ${user.last_name} (${user.telegram_id || user.phone_number})`);
    }
    console.log(`✅ Migrated ${users.length} users\n`);

    // ========================================================================
    // STEP 3: Create Family Memberships
    // ========================================================================
    console.log("🔗 Creating family memberships...");
    for (const [oldId, newId] of userIdMap.entries()) {
      const role = newId === primaryUserId ? 'owner' : 'member';
      await pg.query(
        `INSERT INTO family_memberships (user_id, family_id, role, joined_at)
         VALUES ($1, $2, $3, NOW())`,
        [newId, familyId, role]
      );
      console.log(`  ✓ User ${newId}: ${role}`);
    }
    console.log(`✅ Created ${userIdMap.size} memberships\n`);

    // ========================================================================
    // STEP 4: Migrate Facts
    // ========================================================================
    console.log("📝 Migrating facts...");
    const facts = sqlite.query("SELECT * FROM facts").all() as Fact[];
    let factCount = 0;

    for (const fact of facts) {
      const newUserId = userIdMap.get(fact.user_id);
      if (!newUserId) continue;

      await pg.query(
        `INSERT INTO facts (user_id, family_id, key, value, scope, tags, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          newUserId,
          familyId,
          fact.key,
          fact.value,
          fact.scope || 'user',
          fact.tags || '[]',
          fact.created_at,
          fact.updated_at
        ]
      );
      factCount++;
    }
    console.log(`✅ Migrated ${factCount} facts\n`);

    // ========================================================================
    // STEP 5: Migrate Conversation
    // ========================================================================
    console.log("💬 Migrating conversation history...");
    const conversations = sqlite.query("SELECT * FROM conversation ORDER BY user_id, seq").all() as ConversationMessage[];
    let convCount = 0;

    for (const msg of conversations) {
      const newUserId = userIdMap.get(msg.user_id);
      if (!newUserId) continue;

      await pg.query(
        `INSERT INTO conversation (user_id, family_id, seq, role, content, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW())`,
        [newUserId, familyId, msg.seq, msg.role, msg.content]
      );
      convCount++;
    }
    console.log(`✅ Migrated ${convCount} conversation messages\n`);

    // ========================================================================
    // STEP 6: Migrate Summary
    // ========================================================================
    console.log("📊 Migrating summaries...");
    const summaries = sqlite.query("SELECT * FROM summary").all() as Summary[];

    for (const sum of summaries) {
      const newUserId = userIdMap.get(sum.user_id);
      if (!newUserId) continue;

      await pg.query(
        `INSERT INTO summary (user_id, family_id, sentences, created_at, updated_at)
         VALUES ($1, $2, $3, NOW(), NOW())`,
        [newUserId, familyId, sum.sentences]
      );
    }
    console.log(`✅ Migrated ${summaries.length} summaries\n`);

    // ========================================================================
    // STEP 7: Migrate Personality
    // ========================================================================
    console.log("🎭 Migrating personalities...");
    const personalities = sqlite.query("SELECT * FROM personality").all() as Personality[];

    for (const pers of personalities) {
      const newUserId = userIdMap.get(pers.user_id);
      if (!newUserId) continue;

      await pg.query(
        `INSERT INTO user_personalities (user_id, family_id, instructions, created_at, updated_at)
         VALUES ($1, $2, $3, NOW(), NOW())`,
        [newUserId, familyId, pers.instructions]
      );
    }
    console.log(`✅ Migrated ${personalities.length} personalities\n`);

    // ========================================================================
    // STEP 8: Migrate Todos
    // ========================================================================
    console.log("✓ Migrating todos...");
    const todos = sqlite.query("SELECT * FROM todos").all() as Todo[];
    let todoCount = 0;

    for (const todo of todos) {
      const newUserId = userIdMap.get(todo.user_id);
      if (!newUserId) continue;

      const newCreatorId = todo.creator_user_id ? userIdMap.get(todo.creator_user_id) : null;

      await pg.query(
        `INSERT INTO todos (user_id, family_id, creator_user_id, text, done, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          newUserId,
          familyId,
          newCreatorId || newUserId,
          todo.text,
          todo.done === 1,
          todo.created_at
        ]
      );
      todoCount++;
    }
    console.log(`✅ Migrated ${todoCount} todos\n`);

    // ========================================================================
    // STEP 9: Migrate Reminders
    // ========================================================================
    console.log("⏰ Migrating reminders...");
    const reminders = sqlite.query("SELECT * FROM reminders").all() as Reminder[];
    let reminderCount = 0;

    for (const reminder of reminders) {
      const newCreatorId = userIdMap.get(reminder.creator_user_id);
      const newRecipientId = userIdMap.get(reminder.recipient_user_id);
      if (!newCreatorId || !newRecipientId) continue;

      await pg.query(
        `INSERT INTO reminders (creator_user_id, recipient_user_id, family_id, text, kind, fire_at_utc, recurrence, next_fire_at_utc, created_at, sent_at, last_fired_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          newCreatorId,
          newRecipientId,
          familyId,
          reminder.text,
          reminder.kind,
          reminder.fire_at_utc,
          reminder.recurrence,
          reminder.next_fire_at_utc,
          reminder.created_at,
          reminder.sent_at,
          reminder.last_fired_at
        ]
      );
      reminderCount++;
    }
    console.log(`✅ Migrated ${reminderCount} reminders\n`);

    // ========================================================================
    // STEP 10: Migrate Schedule State
    // ========================================================================
    console.log("📅 Migrating schedule state...");
    const scheduleStates = sqlite.query("SELECT * FROM schedule_state").all() as any[];

    for (const state of scheduleStates) {
      const newUserId = userIdMap.get(state.user_id);
      if (!newUserId) continue;

      await pg.query(
        `INSERT INTO schedule_state (user_id, last_convo_end_utc, last_daily_starter_date, last_4h_nudge_date, last_overdue_reminder_date, last_daily_todos_date)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          newUserId,
          state.last_convo_end_utc,
          state.last_daily_starter_date,
          state.last_4h_nudge_date,
          state.last_overdue_reminder_date,
          state.last_daily_todos_date
        ]
      );
    }
    console.log(`✅ Migrated ${scheduleStates.length} schedule states\n`);

    // ========================================================================
    // STEP 11: Migrate Skills Registry
    // ========================================================================
    console.log("🔧 Migrating skills registry...");
    const skills = sqlite.query("SELECT * FROM skills_registry").all() as any[];

    for (const skill of skills) {
      await pg.query(
        `INSERT INTO skills_registry (id, name, description, entrypoint, input_schema)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO NOTHING`,
        [skill.id, skill.name, skill.description, skill.entrypoint, skill.input_schema]
      );
    }
    console.log(`✅ Migrated ${skills.length} skills\n`);

    // ========================================================================
    // STEP 12: Migrate Skills Access
    // ========================================================================
    console.log("🔐 Migrating skills access...");
    const defaultSkills = sqlite.query("SELECT * FROM skills_access_default").all() as any[];

    for (const skill of defaultSkills) {
      await pg.query(
        `INSERT INTO skills_access_default (skill_id)
         VALUES ($1)
         ON CONFLICT (skill_id) DO NOTHING`,
        [skill.skill_id]
      );
    }

    const userSkills = sqlite.query("SELECT * FROM skills_access_by_user").all() as any[];
    for (const userSkill of userSkills) {
      const newUserId = userIdMap.get(userSkill.user_id);
      if (!newUserId) continue;

      await pg.query(
        `INSERT INTO skills_access_by_user (user_id, skill_id)
         VALUES ($1, $2)
         ON CONFLICT (user_id, skill_id) DO NOTHING`,
        [newUserId, userSkill.skill_id]
      );
    }
    console.log(`✅ Migrated skills access\n`);

    // ========================================================================
    // STEP 13: Migrate Config
    // ========================================================================
    console.log("⚙️  Migrating config...");
    const configs = sqlite.query("SELECT * FROM config").all() as any[];

    for (const config of configs) {
      // Update primary_user_id to new user ID
      let value = config.value;
      if (config.key === 'primary_user_id') {
        const oldUserId = parseInt(value);
        const newUserId = userIdMap.get(oldUserId);
        if (newUserId) {
          value = newUserId.toString();
        }
      }

      await pg.query(
        `INSERT INTO config (key, value)
         VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = $2`,
        [config.key, value]
      );
    }
    console.log(`✅ Migrated ${configs.length} config entries\n`);

    // ========================================================================
    // STEP 14: Migrate LLM Log
    // ========================================================================
    console.log("📜 Migrating LLM log...");
    const llmLogs = sqlite.query("SELECT * FROM llm_log ORDER BY id LIMIT 1000").all() as any[];

    for (const log of llmLogs) {
      const newUserId = log.user_id ? userIdMap.get(log.user_id) : null;

      await pg.query(
        `INSERT INTO llm_log (request_id, user_id, family_id, owner, step, request_doc, response_text, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          log.request_id,
          newUserId,
          newUserId ? familyId : null,
          log.owner || 'default',
          log.step,
          log.request_doc || null,
          log.response_text || null,
          log.created_at
        ]
      );
    }
    console.log(`✅ Migrated ${llmLogs.length} LLM log entries (most recent 1000)\n`);

    // ========================================================================
    // Commit transaction
    // ========================================================================
    await pg.query('COMMIT');
    
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("✨ Migration completed successfully!");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log(`\n📊 Summary:`);
    console.log(`   • Family: Hogue Family (ID: ${familyId})`);
    console.log(`   • Users: ${users.length}`);
    console.log(`   • Facts: ${factCount}`);
    console.log(`   • Conversations: ${convCount}`);
    console.log(`   • Todos: ${todoCount}`);
    console.log(`   • Reminders: ${reminderCount}`);
    console.log(`   • System Admin: User ${primaryUserId} (Jon Hogue)`);
    console.log(`\n🚀 Next steps:`);
    console.log(`   1. Verify data in PostgreSQL`);
    console.log(`   2. Test bot functionality`);
    console.log(`   3. Deploy to Railway\n`);

  } catch (error) {
    await pg.query('ROLLBACK');
    console.error("\n❌ Migration failed:", error);
    throw error;
  } finally {
    sqlite.close();
    await pg.end();
  }
}

// Run migration
migrate().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
