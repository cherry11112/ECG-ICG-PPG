/**
 * Migration script to add session_answers table
 * 
 * This table stores temporary session answers for voice feedback collection.
 * Answers are stored here during the conversation and only committed to
 * feedback_form when all 27 questions are answered.
 * 
 * Run this script once to initialize the table:
 *   node scripts/add_session_answers_table.js
 */

import pg from 'pg';
import { config } from 'dotenv';

config();

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

async function createTable() {
  const client = await pool.connect();
  try {
    console.log('Creating session_answers table...');

    // Create the main table
    await client.query(`
      CREATE TABLE IF NOT EXISTS session_answers (
        id serial primary key,
        patient_id integer not null references users(id) on delete cascade,
        session_id text not null,
        question_id text not null,
        answer_value text,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        UNIQUE(session_id, question_id)
      );
    `);
    console.log('✓ session_answers table created');

    // Create indexes
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_session_answers_session 
      ON session_answers(session_id);
    `);
    console.log('✓ Index on session_id created');

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_session_answers_patient_session 
      ON session_answers(patient_id, session_id);
    `);
    console.log('✓ Index on (patient_id, session_id) created');

    console.log('\n✅ Migration completed successfully!');
    console.log('\nThe session_answers table is now ready to use.');
    console.log('Answers will be stored temporarily and committed to feedback_form');
    console.log('only when all 27 questions are answered.');

  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

createTable();
