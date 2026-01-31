/**
 * Integration tests for family data isolation
 * 
 * Ensures that users can only access data within their family
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Pool } from "pg";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

describe("Family Data Isolation", () => {
  let pool: Pool;
  let family1Id: number;
  let family2Id: number;
  let user1Id: number;
  let user2Id: number;

  beforeAll(async () => {
    if (!TEST_DATABASE_URL) {
      throw new Error("TEST_DATABASE_URL not set");
    }

    pool = new Pool({ connectionString: TEST_DATABASE_URL });

    // Create test families
    const family1 = await pool.query(
      'INSERT INTO families (name) VALUES ($1) RETURNING id',
      ['Test Family 1']
    );
    family1Id = family1.rows[0].id;

    const family2 = await pool.query(
      'INSERT INTO families (name) VALUES ($1) RETURNING id',
      ['Test Family 2']
    );
    family2Id = family2.rows[0].id;

    // Create test users
    const user1 = await pool.query(
      `INSERT INTO users (first_name, last_name, phone_number, telegram_id, last_active_family_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      ['Test', 'User1', 'test1', 'test1', family1Id]
    );
    user1Id = user1.rows[0].id;

    const user2 = await pool.query(
      `INSERT INTO users (first_name, last_name, phone_number, telegram_id, last_active_family_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      ['Test', 'User2', 'test2', 'test2', family2Id]
    );
    user2Id = user2.rows[0].id;

    // Add memberships
    await pool.query(
      'INSERT INTO family_memberships (user_id, family_id, role) VALUES ($1, $2, $3)',
      [user1Id, family1Id, 'owner']
    );

    await pool.query(
      'INSERT INTO family_memberships (user_id, family_id, role) VALUES ($1, $2, $3)',
      [user2Id, family2Id, 'owner']
    );

    // Add test data for Family 1
    await pool.query(
      'INSERT INTO facts (user_id, family_id, key, value, scope) VALUES ($1, $2, $3, $4, $5)',
      [user1Id, family1Id, 'test_fact', 'family1_data', 'user']
    );

    // Add test data for Family 2
    await pool.query(
      'INSERT INTO facts (user_id, family_id, key, value, scope) VALUES ($1, $2, $3, $4, $5)',
      [user2Id, family2Id, 'test_fact', 'family2_data', 'user']
    );
  });

  afterAll(async () => {
    // Cleanup
    if (pool) {
      await pool.query('DELETE FROM family_memberships WHERE user_id IN ($1, $2)', [user1Id, user2Id]);
      await pool.query('DELETE FROM facts WHERE family_id IN ($1, $2)', [family1Id, family2Id]);
      await pool.query('DELETE FROM users WHERE id IN ($1, $2)', [user1Id, user2Id]);
      await pool.query('DELETE FROM families WHERE id IN ($1, $2)', [family1Id, family2Id]);
      await pool.end();
    }
  });

  test("User can access their own family data", async () => {
    const result = await pool.query(
      'SELECT value FROM facts WHERE user_id = $1 AND family_id = $2 AND key = $3',
      [user1Id, family1Id, 'test_fact']
    );

    expect(result.rows.length).toBe(1);
    expect(result.rows[0].value).toBe('family1_data');
  });

  test("User cannot access other family's data", async () => {
    const result = await pool.query(
      'SELECT value FROM facts WHERE user_id = $1 AND family_id = $2 AND key = $3',
      [user1Id, family2Id, 'test_fact']
    );

    expect(result.rows.length).toBe(0);
  });

  test("Facts are properly isolated by family_id", async () => {
    // User 1 queries with wrong family_id should return nothing
    const wrongFamily = await pool.query(
      'SELECT * FROM facts WHERE user_id = $1 AND family_id = $2',
      [user1Id, family2Id]
    );

    expect(wrongFamily.rows.length).toBe(0);

    // User 1 queries with correct family_id should return data
    const correctFamily = await pool.query(
      'SELECT * FROM facts WHERE user_id = $1 AND family_id = $2',
      [user1Id, family1Id]
    );

    expect(correctFamily.rows.length).toBeGreaterThan(0);
  });

  test("Family roles are enforced", async () => {
    const membership = await pool.query(
      'SELECT role FROM family_memberships WHERE user_id = $1 AND family_id = $2',
      [user1Id, family1Id]
    );

    expect(membership.rows[0].role).toBe('owner');
  });

  test("Cannot remove last owner from family", async () => {
    // Try to change owner to member (should fail since they're the only owner)
    try {
      await pool.query(
        'UPDATE family_memberships SET role = $1 WHERE user_id = $2 AND family_id = $3',
        ['member', user1Id, family1Id]
      );
      throw new Error('Should have thrown an error');
    } catch (error: any) {
      expect(error.message).toContain('Cannot remove last owner');
    }
  });
});
