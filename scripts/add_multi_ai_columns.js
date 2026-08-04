// Migration script to add multi-AI diagnostic columns to diagnostic_results table
// Run this to add support for storing Claude and Gemini results directly in the database

import { sql } from '@vercel/postgres';

async function addMultiAIColumns() {
  try {
    console.log('[Migration] Adding multi-AI diagnostic columns...');

    // Add gemini_result column
    await sql`
      ALTER TABLE diagnostic_results 
      ADD COLUMN IF NOT EXISTS gemini_result jsonb
    `;
    console.log('✓ Added gemini_result column');

    // Add claude_result column
    await sql`
      ALTER TABLE diagnostic_results 
      ADD COLUMN IF NOT EXISTS claude_result jsonb
    `;
    console.log('✓ Added claude_result column');

    // Add agreement_score column
    await sql`
      ALTER TABLE diagnostic_results 
      ADD COLUMN IF NOT EXISTS agreement_score integer
    `;
    console.log('✓ Added agreement_score column');

    // Add consensus_risk_level column
    await sql`
      ALTER TABLE diagnostic_results 
      ADD COLUMN IF NOT EXISTS consensus_risk_level text
    `;
    console.log('✓ Added consensus_risk_level column');

    // Add consensus_risk_percentage column
    await sql`
      ALTER TABLE diagnostic_results 
      ADD COLUMN IF NOT EXISTS consensus_risk_percentage integer
    `;
    console.log('✓ Added consensus_risk_percentage column');

    // Add comparison_analysis column
    await sql`
      ALTER TABLE diagnostic_results 
      ADD COLUMN IF NOT EXISTS comparison_analysis text
    `;
    console.log('✓ Added comparison_analysis column');

    // Add multi_ai_errors column
    await sql`
      ALTER TABLE diagnostic_results 
      ADD COLUMN IF NOT EXISTS multi_ai_errors jsonb
    `;
    console.log('✓ Added multi_ai_errors column');

    // Add multi_ai_available column
    await sql`
      ALTER TABLE diagnostic_results 
      ADD COLUMN IF NOT EXISTS multi_ai_available boolean DEFAULT false
    `;
    console.log('✓ Added multi_ai_available column');

    console.log('[Migration] ✓ All multi-AI columns added successfully!');
    console.log('[Migration] You can now store Gemini and Claude diagnostic results directly in the database.');
  } catch (err) {
    console.error('[Migration] Error adding columns:', err.message);
    if (err.message.includes('already exists')) {
      console.log('[Migration] Columns already exist, skipping...');
    } else {
      throw err;
    }
  }
}

// Run migration
addMultiAIColumns().catch(err => {
  console.error('[Migration] Fatal error:', err);
  process.exit(1);
});
