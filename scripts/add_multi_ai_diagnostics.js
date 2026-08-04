/**
 * Migration script to add multi-AI diagnostic storage
 * Creates a new table to store diagnostic results from multiple AI models
 * Run with: node scripts/add_multi_ai_diagnostics.js
 */

import { sql } from '@vercel/postgres';

async function addMultiAIDiagnostics() {
  try {
    console.log('Creating multi_ai_diagnostics table...');
    
    // Create new table for multi-AI diagnostic results
    await sql`
      CREATE TABLE IF NOT EXISTS multi_ai_diagnostics (
        id SERIAL PRIMARY KEY,
        patient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        primary_diagnostic_id INTEGER REFERENCES diagnostic_results(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        
        -- AI Model Results (storing all 3 models)
        gemini_result JSONB,
        openai_result JSONB,
        claude_result JSONB,
        
        -- Timestamps for each model
        gemini_generated_at TIMESTAMPTZ,
        openai_generated_at TIMESTAMPTZ,
        claude_generated_at TIMESTAMPTZ,
        
        -- Comparison & Consensus
        consensus_risk_level TEXT,
        consensus_risk_percentage INTEGER,
        agreement_score NUMERIC(5, 2),
        
        -- Comparison metrics
        models_agreement JSONB,
        comparison_analysis TEXT,
        
        -- Storage URLs
        cloudflare_comparison_url TEXT
      );
    `;
    
    console.log('✓ multi_ai_diagnostics table created');
    
    // Add index for patient lookups
    await sql`
      CREATE INDEX IF NOT EXISTS idx_multi_ai_patient 
      ON multi_ai_diagnostics(patient_id, created_at DESC)
    `;
    
    console.log('✓ Index created for patient lookups');
    
    // Add columns to diagnostic_results table for AI model identification
    try {
      await sql`
        ALTER TABLE diagnostic_results 
        ADD COLUMN IF NOT EXISTS ai_model_name TEXT DEFAULT 'Gemini 2.0'
      `;
      console.log('✓ ai_model_name column added to diagnostic_results');
    } catch (err) {
      console.log('  (Column may already exist)');
    }
    
    try {
      await sql`
        ALTER TABLE diagnostic_results 
        ADD COLUMN IF NOT EXISTS multi_ai_group_id INTEGER REFERENCES multi_ai_diagnostics(id)
      `;
      console.log('✓ multi_ai_group_id column added to diagnostic_results');
    } catch (err) {
      console.log('  (Column may already exist)');
    }
    
    console.log('\n✅ Migration completed successfully!');
    process.exit(0);
    
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  }
}

addMultiAIDiagnostics();
