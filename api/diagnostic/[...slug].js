// /api/diagnostic/[...slug].js
// Dynamic router for diagnostic and report operations
// Routes:
//   GET /api/diagnostic - Get all reports for a patient (with query params)
//   POST /api/diagnostic/generate-diagnostic - Generate diagnostic report (Gemini AI)
//   POST /api/diagnostic/save-diagnostic - Save diagnostic results to database

import { sql } from '@vercel/postgres';
import { ensureSchema, saveDiagnosticResult, getPatientReports, getFeedbackFormByPatient, getP1ReportFormByPatient, getDiagnosticResultsByPatient } from '../_db.js';
import { requireAuth } from '../_auth.js';
import { calculateAndStoreGRACE3Score, calculateGRACE3Score } from '../_grace3.js';

// API Configuration - Consolidated from _multi_ai.js
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const CLOUDFLARE_R2_URL = process.env.R2_DIRECT_URL || 'https://pub-a0dd8794f43dfsdfdsfsdg447abb764c83ae332144.r2.dev';
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';

// DIAGNOSTIC REPORT GENERATION (Gemini AI)

async function fetchPatientData(patientId) {
  try {
    const feedbackRes = await sql`
      SELECT * FROM feedback_form WHERE patient_id = ${patientId} ORDER BY created_at DESC LIMIT 1
    `;
    const feedbackData = feedbackRes.rows[0] || null;

    const reportRes = await sql`
      SELECT * FROM report_form WHERE patient_id = ${patientId} ORDER BY created_at DESC LIMIT 1
    `;
    const reportData = reportRes.rows[0] || null;

    const userRes = await sql`
      SELECT full_name, created_at FROM users WHERE id = ${patientId}
    `;
    const userData = userRes.rows[0] || null;

    return {
      feedback: feedbackData,
      report: reportData,
      user: userData
    };
  } catch (err) {
    console.error('Error fetching patient data:', err);
    throw err;
  }
}

async function fetchECGResults() {
  try {
    const url = `${CLOUDFLARE_R2_URL}/data/ecg_results.json`;
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json'
      }
    });
    
    if (!response.ok) {
      console.warn(`Could not fetch ECG results from Cloudflare: ${response.status}`);
      return null;
    }
    
    const data = await response.json();
    
    // Handle various possible structures from ECG analysis
    return {
      summary: data.summary || data.diagnostic_summary || null,
      rhythm: data.rhythm || null,
      abnormalities: Array.isArray(data.abnormalities) ? data.abnormalities : [],
      measurements: data.measurements || {},
      // Flatten nested measurement structures
      hr_mean: data.measurements?.hr_mean || data.hr_mean || null,
      hr_min: data.measurements?.hr_min || data.hr_min || null,
      hr_max: data.measurements?.hr_max || data.hr_max || null,
      qrs_width_mean: data.measurements?.qrs_width_mean || data.qrs_width_mean || null,
      qt_interval_mean: data.measurements?.qt_interval_mean || data.qt_interval_mean || null,
      rr_interval_mean: data.measurements?.rr_interval_mean || data.rr_interval_mean || null,
      pr_interval_mean: data.measurements?.pr_interval_mean || data.pr_interval_mean || null,
      st_analysis: data.st_analysis || null,
      images: data.images || {},
      metrics: data.metrics || {}
    };
  } catch (err) {
    console.error('Error fetching ECG results from Cloudflare:', err);
    return null;
  }
}

// Helper function to clean patient data for Gemini analysis
function cleanPatientData(data) {
  if (!data) return null;
  const cleaned = {};
  
  for (const [key, value] of Object.entries(data)) {
    // Skip placeholder values
    if (value === null || value === undefined || value === '' || value === 'n.A' || value === 'N/A' || value === 'null' || value === 'N/A' || value === 'Not Applicable') {
      continue; // Don't include this field
    }
    // Skip 'id' and timestamp fields
    if (key === 'id' || key === 'patient_id' || key.includes('created_at') || key.includes('updated_at')) {
      continue;
    }
    cleaned[key] = value;
  }
  
  return Object.keys(cleaned).length > 0 ? cleaned : null;
}

// Helper function to generate clinical context about normal ranges and data interpretation
function getNormalRangesContext() {
  return `
NORMAL CLINICAL REFERENCE RANGES:
- Blood Pressure: Systolic 90-120 mmHg, Diastolic 60-80 mmHg
- Heart Rate: 60-100 bpm (resting)
- BMI: 18.5-24.9 kg/m²
- LVEF (Left Ventricular Ejection Fraction): >50% (normal), 40-50% (mildly reduced), <40% (significantly reduced)
- Troponin T: <0.03 ng/mL (normal)
- Troponin I: <0.04 ng/mL (normal)
- NT-proBNP: <100 pg/mL (normal/low risk)
- CRP: <3 mg/L (normal)
- LDL Cholesterol: <100 mg/dL (optimal)
- HDL Cholesterol: >40 mg/dL male, >50 mg/dL female (desirable)
- Triglycerides: <150 mg/dL (normal)
- BUN: 7-20 mg/dL
- Creatinine: 0.7-1.3 mg/dL
- HbA1c: <5.7% (normal), 5.7-6.4% (prediabetic), >6.5% (diabetic)

DATA INTERPRETATION GUIDELINES:
- Fields with missing values (not provided/n.A) should NOT automatically increase risk
- Absence of abnormal findings and absence of symptoms = lower risk, NOT higher risk
- For missing lab values without abnormal history: assume normal/unremarkable
- For healthy daily assessments (no dyspnea, no chest pain, no palpitations, etc.): indicate LOW risk, NOT high risk
- Only include in risk assessment conditions where there is actual clinical evidence or concerning data
- If most data is normal/missing and no symptoms reported: Overall risk should be "Very Low" to "Low", not "High"
`;
}

// Helper function to format blood pressure metrics from ECG data
function formatBloodPressureMetrics(ecgData) {
  if (!ecgData || !ecgData.metrics) {
    return 'No blood pressure data available';
  }

  const m = ecgData.metrics;
  const hasBPData = m.systolic_bp_mean !== undefined || m.diastolic_bp_mean !== undefined;

  if (!hasBPData) {
    return 'No blood pressure measurements recorded';
  }

  let report = 'Blood Pressure Measurements:\n';

  if (m.systolic_bp_mean !== undefined) {
    report += `- Systolic BP: Mean ${m.systolic_bp_mean} mmHg (Range: ${m.systolic_bp_min || 'N/A'} - ${m.systolic_bp_max || 'N/A'} mmHg)\n`;
  }

  if (m.diastolic_bp_mean !== undefined) {
    report += `- Diastolic BP: Mean ${m.diastolic_bp_mean} mmHg (Range: ${m.diastolic_bp_min || 'N/A'} - ${m.diastolic_bp_max || 'N/A'} mmHg)\n`;
  }

  if (m.pulse_pressure_mean !== undefined) {
    report += `- Pulse Pressure: Mean ${m.pulse_pressure_mean} mmHg (Range: ${m.pulse_pressure_min || 'N/A'} - ${m.pulse_pressure_max || 'N/A'} mmHg)\n`;
  }

  if (m.mean_arterial_pressure_mean !== undefined) {
    report += `- Mean Arterial Pressure (MAP): Mean ${m.mean_arterial_pressure_mean} mmHg (Range: ${m.mean_arterial_pressure_min || 'N/A'} - ${m.mean_arterial_pressure_max || 'N/A'} mmHg)\n`;
  }

  report += '\nInterpretation:\n';
  report += '- Normal BP range: Systolic 90-120 mmHg, Diastolic 60-80 mmHg\n';
  
  // Add interpretation based on actual values
  if (m.systolic_bp_mean !== undefined) {
    if (m.systolic_bp_mean < 90) {
      report += `- Systolic BP ${m.systolic_bp_mean} is LOW (hypotension)\n`;
    } else if (m.systolic_bp_mean <= 120) {
      report += `- Systolic BP ${m.systolic_bp_mean} is NORMAL\n`;
    } else if (m.systolic_bp_mean <= 139) {
      report += `- Systolic BP ${m.systolic_bp_mean} is ELEVATED\n`;
    } else {
      report += `- Systolic BP ${m.systolic_bp_mean} is HIGH (stage 1 or 2 hypertension)\n`;
    }
  }

  if (m.diastolic_bp_mean !== undefined) {
    if (m.diastolic_bp_mean < 60) {
      report += `- Diastolic BP ${m.diastolic_bp_mean} is LOW (hypotension)\n`;
    } else if (m.diastolic_bp_mean <= 80) {
      report += `- Diastolic BP ${m.diastolic_bp_mean} is NORMAL\n`;
    } else if (m.diastolic_bp_mean <= 89) {
      report += `- Diastolic BP ${m.diastolic_bp_mean} is ELEVATED\n`;
    } else {
      report += `- Diastolic BP ${m.diastolic_bp_mean} is HIGH (stage 1 or 2 hypertension)\n`;
    }
  }

  return report;
}

// ============================================================================
// SHARED HELPER FUNCTIONS
// ============================================================================

/**
 * Normalize diagnostic condition results to ensure all 19 conditions are present
 */
function normalizeConditionAssessments(diagnosticData) {
  const expectedConditions = [
    'myocardial_infarction',
    'stroke',
    'sudden_cardiac_death',
    'coronary_artery_disease',
    'heart_failure',
    'atrial_fibrillation',
    'hypertrophic_cardiomyopathy',
    'dilated_cardiomyopathy',
    'pulmonary_embolism',
    'aortic_dissection',
    'endocarditis',
    'peripheral_artery_disease',
    'complete_heart_block',
    'cardiac_arrest',
    'angina_pectoris',
    'pulmonary_hypertension',
    'pericarditis',
    'pulmonary_edema',
    'peripheral_edema'
  ];

  if (!diagnosticData.condition_risk_assessments) {
    diagnosticData.condition_risk_assessments = {};
  }

  expectedConditions.forEach(condition => {
    if (!diagnosticData.condition_risk_assessments[condition] || 
        diagnosticData.condition_risk_assessments[condition] === 'Not assessed' ||
        diagnosticData.condition_risk_assessments[condition] === null) {
      diagnosticData.condition_risk_assessments[condition] = 'Very Low';
    }
  });

  // Ensure arrays
  diagnosticData.risk_factors = Array.isArray(diagnosticData.risk_factors) ? diagnosticData.risk_factors : [];
  diagnosticData.key_findings = Array.isArray(diagnosticData.key_findings) ? diagnosticData.key_findings : [];
  diagnosticData.cardiac_recommendations = Array.isArray(diagnosticData.cardiac_recommendations) ? diagnosticData.cardiac_recommendations : [];
  diagnosticData.lifestyle_modifications = Array.isArray(diagnosticData.lifestyle_modifications) ? diagnosticData.lifestyle_modifications : [];
  diagnosticData.urgent_concerns = Array.isArray(diagnosticData.urgent_concerns) ? diagnosticData.urgent_concerns : [];

  return diagnosticData;
}

/**
 * Apply safety checks for asymptomatic patients with no abnormal findings
 */
function applySafetyChecks(diagnosticData, patientData) {
  const hasSymptoms = patientData.feedback && (
    patientData.feedback.dyspnea === 'Yes' ||
    patientData.feedback.chest_pain === 'Yes' ||
    patientData.feedback.palpitations === 'Yes' ||
    patientData.feedback.leg_swelling === 'Yes' ||
    patientData.feedback.orthopnea === 'Yes'
  );

  if (!hasSymptoms && (!diagnosticData.key_findings || diagnosticData.key_findings.length === 0)) {
    if (diagnosticData.risk_percentage > 25) {
      diagnosticData.risk_percentage = 15;
      diagnosticData.risk_level = 'Very Low';
    }
  }

  return diagnosticData;
}

// ============================================================================
// ============================================================================
// CLAUDE DIAGNOSTIC GENERATION 
// ============================================================================

/**
 * Slim ECG data to only clinically relevant summary fields for Claude prompt.
 * Strips raw time-series, image blobs, and large metric arrays that bloat tokens.
 */
function slimECGForClaude(ecgData) {
  if (!ecgData) return null;
  return {
    summary: ecgData.summary || null,
    rhythm: ecgData.rhythm || null,
    abnormalities: Array.isArray(ecgData.abnormalities) ? ecgData.abnormalities.slice(0, 10) : [],
    hr_mean: ecgData.hr_mean ?? null,
    hr_min: ecgData.hr_min ?? null,
    hr_max: ecgData.hr_max ?? null,
    qrs_width_mean: ecgData.qrs_width_mean ?? null,
    qt_interval_mean: ecgData.qt_interval_mean ?? null,
    pr_interval_mean: ecgData.pr_interval_mean ?? null,
    st_analysis: ecgData.st_analysis || null,
    // Blood pressure summary only — no min/max arrays
    systolic_bp_mean: ecgData.metrics?.systolic_bp_mean ?? null,
    diastolic_bp_mean: ecgData.metrics?.diastolic_bp_mean ?? null,
    // Intentionally omit: images, full metrics object, raw waveform data
  };
}

/**
 * Truncate a JSON-serialisable object so its stringified form stays under
 * `maxChars` characters. Fields are dropped from the end of Object.entries()
 * until the budget is met. Arrays are sliced to 20 items max as a first pass.
 */
function truncateToCharBudget(obj, maxChars = 8000) {
  if (!obj) return obj;
  // Shallow-clone and slice any arrays
  const copy = {};
  for (const [k, v] of Object.entries(obj)) {
    copy[k] = Array.isArray(v) ? v.slice(0, 20) : v;
  }
  // Drop fields from the tail until we're under budget
  const keys = Object.keys(copy);
  while (JSON.stringify(copy).length > maxChars && keys.length > 0) {
    delete copy[keys.pop()];
  }
  return copy;
}

/**
 * Generate cardiovascular diagnostic report using Claude Haiku model.
 * Prompt is kept well under 180k tokens by slimming ECG and truncating patient data.
 */
async function generateClaudeDiagnostic(patientData, ecgData) {
  if (!CLAUDE_API_KEY) {
    throw new Error('CLAUDE_API_KEY not configured');
  }

  const cleanedFeedback = truncateToCharBudget(cleanPatientData(patientData.feedback), 6000);
  const cleanedReport   = truncateToCharBudget(cleanPatientData(patientData.report),   6000);
  const cleanedECG      = slimECGForClaude(ecgData);  // already small — no full metrics blob

  const feedbackStr = cleanedFeedback ? JSON.stringify(cleanedFeedback) : 'No abnormalities';
  const reportStr   = cleanedReport   ? JSON.stringify(cleanedReport)   : 'None';
  const ecgStr      = cleanedECG      ? JSON.stringify(cleanedECG)      : 'No abnormalities';

  const prompt = `You are a cardiovascular AI. Analyze this patient and respond with ONLY valid JSON (no markdown).

KEY RULES:
- Risk based ONLY on clinical evidence
- Missing data → LOWER risk
- No assumptions
- Asymptomatic + no findings → "Very Low" to "Low"

PATIENT: ${patientData.user ? patientData.user.full_name : 'Unknown'}

FINDINGS: ${feedbackStr}

HISTORY: ${reportStr}

ECG: ${ecgStr}

OUTPUT JSON format:
{
  "risk_level": "Very Low|Low|Moderate|High|Very High",
  "risk_percentage": <number 0-100>,
  "condition_risk_assessments": {
    "myocardial_infarction": "risk level",
    "stroke": "risk level",
    "sudden_cardiac_death": "risk level",
    "coronary_artery_disease": "risk level",
    "heart_failure": "risk level",
    "atrial_fibrillation": "risk level",
    "hypertrophic_cardiomyopathy": "risk level",
    "dilated_cardiomyopathy": "risk level",
    "pulmonary_embolism": "risk level",
    "aortic_dissection": "risk level",
    "endocarditis": "risk level",
    "peripheral_artery_disease": "risk level",
    "complete_heart_block": "risk level",
    "cardiac_arrest": "risk level",
    "angina_pectoris": "risk level",
    "pulmonary_hypertension": "risk level",
    "pericarditis": "risk level",
    "pulmonary_edema": "risk level",
    "peripheral_edema": "risk level"
  },
  "risk_factors": [],
  "key_findings": [],
  "clinical_assessment": "professional assessment",
  "detailed_recommendations": "detailed clinical recommendations",
  "cardiac_recommendations": [],
  "lifestyle_modifications": [],
  "monitoring_plan": "monitoring strategy",
  "follow_up_timeline": "follow-up schedule",
  "urgent_concerns": [],
  "confidence_level": <0-100>,
  "summary": "executive summary",
  "prognosis_note": "prognosis note"
}`;

  try {
    const response = await fetch(CLAUDE_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 10000,
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ]
      })
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('[Claude] API error:', error);
      throw new Error(`Claude API error: ${response.status}`);
    }

    const result = await response.json();
    const content = result.content?.[0]?.text || '';
    
    if (!content) {
      throw new Error('No content in Claude response');
    }

    // Parse JSON from response (handle markdown code blocks)
    let diagnosticData;
    try {
      diagnosticData = JSON.parse(content);
    } catch (parseErr) {
      // Try to extract JSON from markdown code blocks
      const jsonMatch = content.match(/\`\`\`(?:json)?\s*([\s\S]*?)\s*\`\`\`/);
      if (jsonMatch) {
        diagnosticData = JSON.parse(jsonMatch[1]);
      } else {
        // Try to find JSON object
        const jsonStart = content.indexOf('{');
        const jsonEnd = content.lastIndexOf('}');
        if (jsonStart !== -1 && jsonEnd !== -1) {
          diagnosticData = JSON.parse(content.substring(jsonStart, jsonEnd + 1));
        } else {
          throw parseErr;
        }
      }
    }

    diagnosticData = normalizeConditionAssessments(diagnosticData);
    diagnosticData = applySafetyChecks(diagnosticData, patientData);

    return diagnosticData;

  } catch (err) {
    console.error('[Claude] Error:', err.message);
    throw err;
  }
}

// ============================================================================
// MULTI-AI ORCHESTRATION FUNCTIONS
// ============================================================================

/**
 * Convert risk level string to numeric value for comparison
 */
function riskLevelToNumber(level) {
  const mapping = {
    'very low': 10,
    'low': 25,
    'moderate': 50,
    'high': 75,
    'very high': 95
  };
  return mapping[level?.toLowerCase()] || 50;
}

/**
 * Convert numeric value back to risk level category
 */
function numberToRiskLevel(percentage) {
  if (percentage <= 10) return 'Very Low';
  if (percentage <= 25) return 'Low';
  if (percentage <= 50) return 'Moderate';
  if (percentage <= 75) return 'High';
  return 'Very High';
}

/**
 * Calculate agreement score between Gemini and Claude AI models
 */
function calculateAgreementScore(geminiResult, claudeResult) {
  let agreementPoints = 0;
  const totalPoints = 12;

  // Compare overall risk levels
  const geminiNum = riskLevelToNumber(geminiResult.risk_level);
  const claudeNum = riskLevelToNumber(claudeResult.risk_level);

  const riskDiff = Math.abs(geminiNum - claudeNum);
  if (riskDiff <= 25) agreementPoints += 3;

  // Compare urgent concerns
  const geminiUrgent = geminiResult.urgent_concerns?.length || 0;
  const claudeUrgent = claudeResult.urgent_concerns?.length || 0;

  if (geminiUrgent === claudeUrgent) {
    agreementPoints += 2;
  }

  // Compare key findings similarity
  const geminiFindings = new Set((geminiResult.key_findings || []).map(f => f?.toLowerCase()));
  const claudeFindings = new Set((claudeResult.key_findings || []).map(f => f?.toLowerCase()));

  const intersection = [...geminiFindings].filter(x => claudeFindings.has(x));
  if (intersection.length >= Math.max(geminiFindings.size, claudeFindings.size) * 0.5) {
    agreementPoints += 2;
  }

  // Compare confidence levels
  const geminiConf = geminiResult.confidence_level || 50;
  const claudeConf = claudeResult.confidence_level || 50;

  const confDiff = Math.abs(geminiConf - claudeConf);
  if (confDiff <= 20) agreementPoints += 2;

  // Compare risk percentages
  const geminiPct = geminiResult.risk_percentage || 50;
  const claudePct = claudeResult.risk_percentage || 50;

  const pctDiff = Math.abs(geminiPct - claudePct);
  if (pctDiff <= 15) agreementPoints += 1;

  return Math.round((agreementPoints / totalPoints) * 100);
}

/**
 * Calculate consensus risk assessment across Gemini and Claude models
 */
function calculateConsensus(geminiResult, claudeResult) {
  const avgRiskPct = Math.round(
    (geminiResult.risk_percentage + claudeResult.risk_percentage) / 2
  );

  const consensusRiskLevel = numberToRiskLevel(avgRiskPct);

  const conditions = Object.keys(geminiResult.condition_risk_assessments || {});
  const consensusConditions = {};

  conditions.forEach(condition => {
    const geminiLevel = geminiResult.condition_risk_assessments?.[condition] || 'Very Low';
    const claudeLevel = claudeResult.condition_risk_assessments?.[condition] || 'Very Low';

    const levels = [geminiLevel, claudeLevel].map(riskLevelToNumber);
    const avgLevel = Math.round(levels.reduce((a, b) => a + b) / 2);
    consensusConditions[condition] = numberToRiskLevel(avgLevel);
  });

  return {
    risk_level: consensusRiskLevel,
    risk_percentage: avgRiskPct,
    condition_risk_assessments: consensusConditions
  };
}

/**
 * Generate detailed comparison analysis across Gemini and Claude models
 */
function generateComparisonAnalysis(geminiResult, claudeResult) {
  const models = [
    { name: 'Gemini', data: geminiResult },
    { name: 'Claude', data: claudeResult }
  ];

  let analysis = 'Multi-AI Comparison Analysis:\n\n';

  analysis += 'RISK ASSESSMENT COMPARISON:\n';
  analysis += '─'.repeat(50) + '\n';
  models.forEach(m => {
    analysis += `${m.name.padEnd(12)} | Risk: ${m.data.risk_level.padEnd(12)} (${m.data.risk_percentage}%) | Confidence: ${m.data.confidence_level}%\n`;
  });
  analysis += '\n';

  analysis += 'AREAS OF AGREEMENT:\n';
  analysis += '─'.repeat(50) + '\n';

  const riskLevels = models.map(m => m.data.risk_level);
  if (riskLevels[0] === riskLevels[1]) {
    analysis += 'Both models agree on overall risk level\n';
  } else {
    analysis += `Models diverge on risk assessment: Gemini "${riskLevels[0]}" vs Claude "${riskLevels[1]}"\n`;
  }

  const allUrgent = new Set();
  models.forEach(m => {
    (m.data.urgent_concerns || []).forEach(u => allUrgent.add(u));
  });

  if (allUrgent.size > 0) {
    analysis += ` Identified ${allUrgent.size} urgent concern(s) across models\n`;
    Array.from(allUrgent).forEach(concern => {
      analysis += `  - ${concern}\n`;
    });
  } else {
    analysis += ' No urgent concerns identified by any model\n';
  }

  analysis += '\n';

  analysis += 'AREAS OF DIVERGENCE:\n';
  analysis += '─'.repeat(50) + '\n';

  const riskPcts = models.map(m => m.data.risk_percentage);
  const riskRange = Math.max(...riskPcts) - Math.min(...riskPcts);
  if (riskRange > 20) {
    analysis += `Risk percentage varies by ${riskRange}% across models\n`;
  }

  const confLevels = models.map(m => m.data.confidence_level);
  const confRange = Math.max(...confLevels) - Math.min(...confLevels);
  if (confRange > 15) {
    analysis += `Confidence levels vary by ${confRange}% across models\n`;
  }

  analysis += '\n';

  analysis += 'CLINICAL RECOMMENDATIONS:\n';
  analysis += '─'.repeat(50) + '\n';

  const allRecs = new Set();
  models.forEach(m => {
    (m.data.cardiac_recommendations || []).forEach(r => allRecs.add(r));
  });

  if (allRecs.size > 0) {
    analysis += `${allRecs.size} total unique recommendations from models\n`;
    Array.from(allRecs).slice(0, 5).forEach(rec => {
      const mentioned = models.filter(m => 
        m.data.cardiac_recommendations?.includes(rec)
      ).length;
      const percent = Math.round((mentioned / 2) * 100);
      analysis += `  [${percent}%] ${rec}\n`;
    });
  }

  return analysis;
}

/**
 * Main function: Generate multi-AI diagnostic with comparison across Gemini and Claude
 * Returns results from both models, agreement scores, and consensus analysis
 */
async function generateMultiAIDiagnostic(patientData, ecgData, geminiResult) {
  console.log('[multi-ai] Starting multi-AI diagnostic generation...');
  
  const hasClaudeKey = !!CLAUDE_API_KEY;
  
  if (!hasClaudeKey) {
    console.warn('[multi-ai] Multi-AI diagnostics unavailable:');
    console.warn('[multi-ai]   - CLAUDE_API_KEY not configured');
    console.warn('[multi-ai] Set environment variables to enable multi-AI comparison:');
    console.warn('[multi-ai]   - CLAUDE_API_KEY (from https://console.anthropic.com/)');
  }

  const results = {
    gemini_result: null,
    claude_result: null,
    gemini_generated_at: new Date().toISOString(),
    claude_generated_at: null,
    errors: [],
    multiAIAvailable: hasClaudeKey
  };

  // Gemini is already provided
  if (geminiResult) {
    results.gemini_result = geminiResult;
    console.log('[multi-ai] Gemini result provided');
  }

  // Generate Claude diagnostic
  if (!hasClaudeKey) {
    console.warn('[multi-ai] Skipping Claude diagnostic (API key not configured)');
    results.errors.push({
      model: 'Claude',
      error: 'CLAUDE_API_KEY not configured',
      timestamp: new Date().toISOString()
    });
  } else {
    try {
      console.log('[multi-ai] Generating Claude diagnostic...');
      results.claude_result = await generateClaudeDiagnostic(patientData, ecgData);
      results.claude_generated_at = new Date().toISOString();
      console.log('[multi-ai] Claude diagnostic generated');
    } catch (err) {
      console.error('[multi-ai] Claude generation failed:', err.message);
      results.errors.push({
        model: 'Claude',
        error: err.message,
        timestamp: new Date().toISOString()
      });
    }
  }

  // Calculate comparison metrics only if both results are available
  if (results.gemini_result && results.claude_result) {
    const agreementScore = calculateAgreementScore(
      results.gemini_result,
      results.claude_result
    );

    const consensus = calculateConsensus(
      results.gemini_result,
      results.claude_result
    );

    const comparison = generateComparisonAnalysis(
      results.gemini_result,
      results.claude_result
    );

    results.agreement_score = agreementScore;
    results.consensus_risk_level = consensus.risk_level;
    results.consensus_risk_percentage = consensus.risk_percentage;
    results.models_agreement = {
      gemini_claude_agreement: Math.abs(
        riskLevelToNumber(results.gemini_result.risk_level) -
        riskLevelToNumber(results.claude_result.risk_level)
      ) <= 25
    };
    results.comparison_analysis = comparison;

    console.log('[multi-ai] Comparison metrics calculated');
    console.log('[multi-ai] Overall agreement score:', agreementScore, '%');
    console.log('[multi-ai] Consensus risk:', consensus.risk_level);
  }

  return results;
}

async function generateDiagnosticReport(patientData, ecgData) {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY not configured');
  }

  // Clean the patient data before sending to Gemini
  const cleanedFeedback = cleanPatientData(patientData.feedback);
  const cleanedReport = cleanPatientData(patientData.report);
  const cleanedECG = ecgData ? cleanPatientData(ecgData) : null;

  const context = `
You are a cardiovascular AI diagnostic assistant. Analyze the patient data provided and generate a professional diagnostic report.

PATIENT INFORMATION:
${patientData.user ? `Name: ${patientData.user.full_name}` : 'Name: Not provided'}

${getNormalRangesContext()}

FEEDBACK FORM DATA (Daily Health Assessment):
${cleanedFeedback ? JSON.stringify(cleanedFeedback, null, 2) : 'No abnormal findings reported'}

COMPREHENSIVE REPORT FORM DATA (Detailed Medical History):
${cleanedReport ? JSON.stringify(cleanedReport, null, 2) : 'No abnormal history reported'}

ECG ANALYSIS RESULTS:
${cleanedECG ? JSON.stringify(cleanedECG, null, 2) : 'No ECG abnormalities detected'}

BLOOD PRESSURE ANALYSIS:
${formatBloodPressureMetrics(ecgData)}

CRITICAL INSTRUCTIONS FOR RISK ASSESSMENT (STRICT ENFORCEMENT):

CORE PRINCIPLE:
Risk must be driven ONLY by CURRENT OBJECTIVE CLINICAL EVIDENCE.
- Do NOT assume
- Do NOT speculate
- Do NOT inflate risk due to caution
- Missing or normal data MUST default to LOWER risk

--------------------------------------------------
HARD OVERRIDE RULES (HIGHEST PRIORITY):
--------------------------------------------------

1. NORMAL PATIENT OVERRIDE:
If ALL are true:
- No symptoms reported
- Vitals within normal range
- Labs normal OR no abnormalities reported

THEN:
→ Overall Risk MUST be "Very Low" (0–15%)
→ NO condition may exceed "Low"

2. FAMILY HISTORY RULE:
Family history ALONE:
→ MUST NOT raise overall risk above "Low"
→ MUST NOT raise any condition above "Low"

3. MISSING DATA RULE:
Missing data:
→ MUST NOT increase risk
→ Default to "Very Low" or "Low"

--------------------------------------------------
MANDATORY CALCULATION STEP (CANNOT BE SKIPPED):
--------------------------------------------------

Before assigning final risk:

1. Identify ALL present risk factors
2. Classify each:
   - Minor
   - Moderate
   - Major

3. Assign contribution:

MAJOR FACTORS (+25–40% each):
- Elevated troponin
- LVEF < 40%
- Active chest pain or dyspnea at rest
- Documented arrhythmia (AFib, VT)
- Severe hypertension (>180/120)
- Symptomatic hypotension (<90/60 with symptoms)

MODERATE FACTORS (+10–20% each):
- Persistent hypertension (≥140/90)
- Diabetes mellitus
- BMI ≥ 30
- Elevated LDL / abnormal lipids
- Smoking

MINOR FACTORS (+3–7% each):
- Sedentary lifestyle
- Mild overweight
- Family history
- Borderline BP (120–139 systolic)

4. APPLY STRICT CAPS:
- Only MINOR factors → MAX 25% (LOW)
- One MODERATE only → MAX 35%
- HIGH risk requires:
   → ≥1 MAJOR factor OR
   → ≥3 MODERATE factors OR
   → clear active symptoms

5. ONLY AFTER calculation → assign final risk

--------------------------------------------------
ABSOLUTE SAFETY CAP:
--------------------------------------------------

If:
- No symptoms
- No MAJOR factors

THEN:
→ Risk MUST NOT exceed 35%
→ HIGH and VERY HIGH are PROHIBITED

--------------------------------------------------
BLOOD PRESSURE RULES (STRICT CONTROL):
--------------------------------------------------

Blood pressure is a CONTRIBUTING factor, NOT dominant unless severe.

Classification:
- <120/80 → Normal → NO impact
- 120–139 → Minor factor ONLY
- ≥140/90 (persistent) → Moderate factor
- ≥180/120 → Major factor

IMPORTANT CONSTRAINTS:
- A SINGLE BP reading MUST NOT be treated as persistent hypertension
- Mild or borderline BP MUST NOT elevate risk above LOW
- BP MUST NOT automatically increase ALL condition risks
- BP affects conditions ONLY if:
   → Clinically significant AND
   → Supported by symptoms or abnormalities

--------------------------------------------------
BLOOD PRESSURE URGENCY:
--------------------------------------------------

Flag as URGENT ONLY if:
- BP >180/120
- BP <90/60 WITH symptoms
- Severe hypertension WITH symptoms

--------------------------------------------------
RISK LEVEL DEFINITIONS:
--------------------------------------------------

- VERY LOW (0–10%): No findings
- LOW (11–25%): Minor factors only
- MODERATE (26–50%): ≥2 moderate factors
- HIGH (51–75%): Major factor or clear symptoms
- VERY HIGH (76–100%): Acute/life-threatening evidence ONLY

--------------------------------------------------
CONDITION-SPECIFIC ENFORCEMENT:
--------------------------------------------------

For EACH condition:
- Use ONLY DIRECT evidence
- If no evidence → MUST be "Very Low" or "Low"

STRICT RULE:
→ DO NOT propagate risk across conditions automatically

Examples:
- Myocardial Infarction:
   → High ONLY if chest pain + troponin + ECG changes
- Stroke:
   → High ONLY if neuro symptoms or major risk factors
- Heart Failure:
   → High ONLY if dyspnea + abnormal LVEF/BNP

--------------------------------------------------
CONFIDENCE LEVEL SCORING (0–100):
--------------------------------------------------

Confidence increases with DATA COMPLETENESS AND CLARITY:

HIGH CONFIDENCE (80–100):
- ✓ Comprehensive data available
- ✓ Clear clinical picture
- ✓ Multiple data sources (feedback + report + ECG)
- ✓ No significant missing information
- ✓ Diagnosis/risk assessment is unambiguous

MODERATE CONFIDENCE (50–79):
- ✓ Adequate data but some gaps
- ✓ Missing one data source (e.g., ECG or labs)
- ✓ Picture is clear but not comprehensive
- ✓ Can make confident assessment with minor caveats

LOW CONFIDENCE (20–49):
- ✗ Significant data gaps
- ✗ Missing multiple critical data sources
- ✗ Incomplete history or findings
- ✗ Cannot fully rule out conditions

VERY LOW CONFIDENCE (0–19):
- ✗ Minimal data available
- ✗ Critical information missing
- ✗ Cannot make reliable assessment

SCORING RULES:
1. Start at 50% base
2. Add 5% for each data source present (feedback, report, ECG) = +15% max
3. Add 10% if symptoms are clearly documented
4. Add 10% if key labs/vitals are available
5. Add 10% if ECG data is complete
6. Subtract 10% for each critical missing field
7. Maximum 100%, minimum 0%

Example: Patient with complete feedback + report + ECG + symptoms + normal labs
= 50 + 15 + 10 + 10 + 10 = 85% (HIGH CONFIDENCE)

--------------------------------------------------
ANTI-OVERESCALATION RULE:
--------------------------------------------------

If:
- Patient asymptomatic
- AND ≥80% of data normal

THEN:
→ Overall risk MUST NOT exceed LOW (≤25%)

--------------------------------------------------
CONFLICT RESOLUTION RULE:
--------------------------------------------------

If ANY rule suggests HIGH risk BUT:
- No symptoms
- No major abnormalities

THEN:
→ LOWER risk ALWAYS overrides higher risk

--------------------------------------------------
TASK:
--------------------------------------------------

Generate a detailed Cardiac Monitoring Report.

Include:
- Blood pressure classification (if present)
- BP as contributing (NOT dominant) factor
- Evidence-based justification ONLY

--------------------------------------------------
OUTPUT FORMAT (STRICT JSON ONLY):
--------------------------------------------------

{
  "risk_level": "Very Low | Low | Moderate | High | Very High",
  "risk_percentage": number,

  "condition_risk_assessments": {
    "Myocardial Infarction": "",
    "Stroke": "",
    "Sudden Cardiac Death": "",
    "Coronary Artery Disease": "",
    "Heart Failure": "",
    "Atrial Fibrillation": "",
    "Hypertrophic Cardiomyopathy": "",
    "Dilated Cardiomyopathy": "",
    "Pulmonary Embolism": "",
    "Aortic Dissection": "",
    "Risk of Endocarditis": "",
    "Peripheral Artery Disease": "",
    "Complete Heart Block": "",
    "Cardiac Arrest": "",
    "Angina Pectoris": "",
    "Pulmonary Hypertension": "",
    "Risk of Pericarditis": "",
    "Pulmonary Edema": "",
    "Peripheral Edema": ""
  },

  "risk_factors": [],
  "key_findings": [],
  "clinical_assessment": "",
  "detailed_recommendations": "",
  "cardiac_recommendations": [],
  "lifestyle_modifications": [],
  "monitoring_plan": "",
  "follow_up_timeline": "",
  "urgent_concerns": [],
  "confidence_level": number,
  "summary": "",
  "prognosis_note": ""
}

--------------------------------------------------
FINAL SAFETY RULE:
--------------------------------------------------

If uncertain:
→ ALWAYS choose LOWER risk
→ NEVER assume disease
→ NEVER escalate without evidence

`;

  try {
    const geminiUrl = `${GEMINI_API_URL}?key=${GEMINI_API_KEY}`;
    
    const response = await fetch(geminiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: context
              }
            ]
          }
        ],
        generationConfig: {
          temperature: 0.3,
          topK: 40,
          topP: 0.95,
          maxOutputTokens: 24000,
          responseMimeType: 'application/json',
        },
        safetySettings: [
          {
            category: 'HARM_CATEGORY_HARASSMENT',
            threshold: 'BLOCK_MEDIUM_AND_ABOVE'
          }
        ]
      })
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('[generateDiagnosticReport] Gemini API error:', error);
      throw new Error(`Gemini API error: ${response.status} - ${error}`);
    }

    const result = await response.json();
    const contentText = result.candidates?.[0]?.content?.parts?.[0]?.text || '';
    
    if (!contentText) {
      throw new Error('No content in Gemini response');
    }
    
    // Remove all markdown code block markers (more aggressive stripping)
    let jsonStr = contentText
      .replace(/```json\s*/gi, '')
      .replace(/```\s*/g, '')
      .trim();
    
    // Find the first { and LAST }
    const jsonStart = jsonStr.indexOf('{');
    const jsonEnd = jsonStr.lastIndexOf('}');
    
    if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
      console.error('[generateDiagnosticReport] Could not find JSON boundaries');
      console.error('[generateDiagnosticReport] Full response length:', contentText.length);
      console.error('[generateDiagnosticReport] First 800 chars:', contentText.substring(0, 800));
      console.error('[generateDiagnosticReport] Last 800 chars:', contentText.substring(Math.max(0, contentText.length - 800)));
      console.error('[generateDiagnosticReport] jsonStart:', jsonStart, 'jsonEnd:', jsonEnd);
      throw new Error('No valid JSON found in Gemini response - response may be truncated');
    }
    
    // Extract JSON between first { and last }
    jsonStr = jsonStr.substring(jsonStart, jsonEnd + 1);
    
    // Try to parse the JSON - handle control characters gracefully
    let diagnosticData;
    try {
      diagnosticData = JSON.parse(jsonStr);
    } catch (parseErr) {
      console.error('[generateDiagnosticReport] JSON parse failed');
      console.error('[generateDiagnosticReport] Extracted length:', jsonStr.length);
      console.error('[generateDiagnosticReport] First 300 chars:', jsonStr.substring(0, 300));
      console.error('[generateDiagnosticReport] Last 300 chars:', jsonStr.substring(Math.max(0, jsonStr.length - 300)));
      console.error('[generateDiagnosticReport] Parse error:', parseErr.message);
      console.error('[generateDiagnosticReport] Error position:', parseErr.message.match(/position (\d+)/)?.[1]);
      
      // Try to find the problem area
      if (parseErr.message.includes('position')) {
        const pos = parseInt(parseErr.message.match(/position (\d+)/)[1]);
        console.error('[generateDiagnosticReport] Around position', pos, ':', jsonStr.substring(Math.max(0, pos - 50), pos + 50));
      }
      
      // Strategy 1: Remove truly problematic control characters (except newlines which JSON.parse handles)
      let cleanJson = jsonStr;
      // Remove null bytes and other truly invalid characters
      cleanJson = cleanJson.replace(/[\x00]/g, ''); // Remove null bytes
      cleanJson = cleanJson.replace(/[\x01-\x07\x0E\x0F\x1B\x1C\x1D\x1E-\x1F]/g, ''); // Remove other problematic control chars
      
      try {
        diagnosticData = JSON.parse(cleanJson);
        console.log('[generateDiagnosticReport] Successfully parsed after removing problematic control characters');
      } catch (cleanErr) {
        console.error('[generateDiagnosticReport] Clean parse also failed:', cleanErr.message);
        console.warn('[generateDiagnosticReport] Response appears truncated or malformed, attempting partial recovery...');
        
        // Strategy 2: Use regex to find and extract complete valid JSON objects
        // Look for condition_risk_assessments which should be parseable
        try {
          // Try to extract and validate the overall structure by finding key JSON objects
          const assessmentsMatch = cleanJson.match(/"condition_risk_assessments":\s*({[\s\S]*?})\s*[,}]/);
          const riskLevelMatch = cleanJson.match(/"risk_level":\s*"([^"]+)"/);
          const riskPercentMatch = cleanJson.match(/"risk_percentage":\s*(\d+)/);
          
          const assessments = assessmentsMatch ? JSON.parse(assessmentsMatch[1]) : {};
          const riskLevel = riskLevelMatch ? riskLevelMatch[1] : 'Moderate';
          const riskPercent = riskPercentMatch ? parseInt(riskPercentMatch[1]) : 50;
          
          diagnosticData = {
            risk_level: riskLevel,
            risk_percentage: riskPercent,
            condition_risk_assessments: assessments,
            risk_factors: ['Partial recovery - full data unavailable'],
            key_findings: [],
            clinical_assessment: 'TRUNCATED RESPONSE - Please retry. Full diagnostic assessment unavailable.',
            detailed_recommendations: 'Please retry the diagnostic report generation.',
            cardiac_recommendations: ['Consult with treating physician'],
            lifestyle_modifications: ['Pending full report'],
            monitoring_plan: 'As directed by physician',
            follow_up_timeline: 'Within 2 weeks',
            urgent_concerns: [],
            confidence_level: 25,
            summary: 'Diagnostic report generation was partially successful. Some data recovered. Please regenerate for complete assessment.'
          };
          
          console.warn('[generateDiagnosticReport] Recovered partial data using regex extraction');
        } catch (fallbackErr) {
          console.error('[generateDiagnosticReport] Fallback recovery also failed:', fallbackErr.message);
          throw new Error(`Failed to parse JSON response: ${parseErr.message}`);
        }
      }
    }
    
    // Normalize condition_risk_assessments to ensure all 19 conditions are present
    if (diagnosticData.condition_risk_assessments) {
      const expectedConditions = [
        'myocardial_infarction',
        'stroke',
        'sudden_cardiac_death',
        'coronary_artery_disease',
        'heart_failure',
        'atrial_fibrillation',
        'hypertrophic_cardiomyopathy',
        'dilated_cardiomyopathy',
        'pulmonary_embolism',
        'aortic_dissection',
        'endocarditis',
        'peripheral_artery_disease',
        'complete_heart_block',
        'cardiac_arrest',
        'angina_pectoris',
        'pulmonary_hypertension',
        'pericarditis',
        'pulmonary_edema',
        'peripheral_edema'
      ];
      
      // Ensure all conditions are present, if missing assign to "Very Low" NEVER cascade high risk
      expectedConditions.forEach(condition => {
        if (!diagnosticData.condition_risk_assessments[condition] || 
            diagnosticData.condition_risk_assessments[condition] === 'Not assessed' ||
            diagnosticData.condition_risk_assessments[condition] === null ||
            diagnosticData.condition_risk_assessments[condition] === 'null') {
          // Default to "Very Low" for missing assessments, not cascading from overall risk
          diagnosticData.condition_risk_assessments[condition] = 'Very Low';
        }
      });
    } else {
      // If no condition_risk_assessments at all, create one with all "Very Low"
      diagnosticData.condition_risk_assessments = {
        'myocardial_infarction': 'Very Low',
        'stroke': 'Very Low',
        'sudden_cardiac_death': 'Very Low',
        'coronary_artery_disease': 'Very Low',
        'heart_failure': 'Very Low',
        'atrial_fibrillation': 'Very Low',
        'hypertrophic_cardiomyopathy': 'Very Low',
        'dilated_cardiomyopathy': 'Very Low',
        'pulmonary_embolism': 'Very Low',
        'aortic_dissection': 'Very Low',
        'endocarditis': 'Very Low',
        'peripheral_artery_disease': 'Very Low',
        'complete_heart_block': 'Very Low',
        'cardiac_arrest': 'Very Low',
        'angina_pectoris': 'Very Low',
        'pulmonary_hypertension': 'Very Low',
        'pericarditis': 'Very Low',
        'pulmonary_edema': 'Very Low',
        'peripheral_edema': 'Very Low'
      };
    }
    
    // Safety check: If patient has no symptoms AND no abnormal findings, cap overall risk at "Low"
    const hasSymptoms = patientData.feedback && (
      patientData.feedback.dyspnea === 'Yes' ||
      patientData.feedback.chest_pain === 'Yes' ||
      patientData.feedback.palpitations === 'Yes' ||
      patientData.feedback.leg_swelling === 'Yes' ||
      patientData.feedback.orthopnea === 'Yes'
    );
    
    const hasAbnormalFindings = diagnosticData.key_findings && diagnosticData.key_findings.length > 0;
    
    if (!hasSymptoms && !hasAbnormalFindings) {
      // Asymptomatic with no abnormal findings - cap at "Low" risk
      const riskCapMap = {
        'very low': 'Very Low',
        'low': 'Low',
        'moderate': 'Low',
        'high': 'Low',
        'very high': 'Low'
      };
      const currentRisk = diagnosticData.risk_level ? diagnosticData.risk_level.toLowerCase() : 'moderate';
      diagnosticData.risk_level = riskCapMap[currentRisk] || 'Low';
      
      // Also cap risk_percentage
      if (diagnosticData.risk_percentage > 25) {
        diagnosticData.risk_percentage = 15; // Very Low = 0-15%
      }
      
      console.log('[generateDiagnosticReport] Safety check applied: Asymptomatic with no abnormal findings, risk capped to:', diagnosticData.risk_level);
    }

    return diagnosticData;
  } catch (err) {
    console.error('[generateDiagnosticReport] Error:', err.message);
    throw err;
  }
}

function buildCompleteReport(diagnosticData, patientData, ecgData = null) {
  // Extract and map demographics
  const demographics = {
    age: patientData.report?.age || null,
    gender: patientData.report?.gender || null,
    height: patientData.report?.height || null,
    weight: patientData.feedback?.weight_kg || patientData.report?.weight || null,
    bmi: patientData.report?.bmi || null,
    nyha: patientData.report?.nyha || null,
    smoking: patientData.report?.smoking || null,
    ethnicity: patientData.report?.ethnicity || null
  };

  // Extract and map vitals
  const vitals = {
    systolic: patientData.feedback?.blood_pressure_systolic || null,
    diastolic: patientData.feedback?.blood_pressure_diastolic || null,
    bmi: patientData.report?.bmi || null,
    weight: patientData.feedback?.weight_kg || patientData.report?.weight || null,
    height: patientData.report?.height || null,
    walkDistance: patientData.feedback?.walk_6min_distance_m || null,
    fatigueLevel: patientData.feedback?.fatigue_level || null,
    sleepQuality: patientData.feedback?.sleep_quality || null
  };

  // Extract and map lab values
  const labs = {
    lvEjectionFraction: patientData.report?.lvef || null,
    cardiacOutput: patientData.report?.cardiac_output || null,
    troponinT: patientData.report?.troponin_t || null,
    troponinI: patientData.report?.troponin_i || null,
    ntProBNP: patientData.report?.nt_probnp || null,
    crp: patientData.report?.crp || null,
    ldl: patientData.report?.ldl || null,
    hdl: patientData.report?.hdl || null,
    triglycerides: patientData.report?.triglycerides || null,
    bun: patientData.report?.bun || null,
    creatinine: patientData.report?.creatinine || null,
    hba1c: patientData.report?.hba1c || null
  };


  // Extract symptoms from feedback
  const symptoms = [];
  if (patientData.feedback?.dyspnea === 'Yes') symptoms.push('Dyspnea');
  if (patientData.feedback?.orthopnea === 'Yes') symptoms.push('Orthopnea');
  if (patientData.feedback?.chest_pain === 'Yes') symptoms.push('Chest Pain');
  if (patientData.feedback?.palpitations === 'Yes') symptoms.push('Palpitations');
  if (patientData.feedback?.leg_swelling === 'Yes') symptoms.push('Leg Swelling');

  // Extract ECG findings from ecgData parameter (passed from fetchECGResults)
  let ecg_findings = null;
  if (ecgData && typeof ecgData === 'object') {
    const metrics = ecgData.metrics || {};
    ecg_findings = {
      // Cardiac metrics
      hrMean: ecgData.hr_mean || null,
      hrMin: ecgData.hr_min || null,
      hrMax: ecgData.hr_max || null,
      qrsWidth: ecgData.qrs_width_mean || null,
      qtInterval: ecgData.qt_interval_mean || null,
      rrInterval: ecgData.rr_interval_mean || null,
      prInterval: ecgData.pr_interval_mean || null,
      stAnalysis: ecgData.st_analysis || null,
      rhythm: ecgData.rhythm || null,
      abnormalities: Array.isArray(ecgData.abnormalities) ? ecgData.abnormalities : [],
      summary: ecgData.summary || null,
      images: ecgData.images || null,
      // Blood pressure metrics
      systolicBpMean: metrics.systolic_bp_mean || null,
      systolicBpMax: metrics.systolic_bp_max || null,
      systolicBpMin: metrics.systolic_bp_min || null,
      diastolicBpMean: metrics.diastolic_bp_mean || null,
      diastolicBpMax: metrics.diastolic_bp_max || null,
      diastolicBpMin: metrics.diastolic_bp_min || null,
      pulsePressureMean: metrics.pulse_pressure_mean || null,
      pulsePressureMax: metrics.pulse_pressure_max || null,
      pulsePressureMin: metrics.pulse_pressure_min || null,
      mapMean: metrics.mean_arterial_pressure_mean || null,
      mapMax: metrics.mean_arterial_pressure_max || null,
      mapMin: metrics.mean_arterial_pressure_min || null
    };
  }

  // Generate prognosis_note from detailed_recommendations (if not already provided)
  let prognosis_note = diagnosticData.prognosis_note || null;
  if (!prognosis_note && diagnosticData.detailed_recommendations) {
    // Take first 200 characters of detailed recommendations as prognosis note
    prognosis_note = diagnosticData.detailed_recommendations.substring(0, 200).trim();
    if (!prognosis_note.endsWith('.')) prognosis_note += '.';
  }
  if (!prognosis_note) {
    prognosis_note = 'To be determined by treating physician based on full diagnostic assessment.';
  }

  // Generate diagnostic_summary from clinical_assessment or summary
  let diagnostic_summary = diagnosticData.diagnostic_summary || null;
  if (!diagnostic_summary && diagnosticData.clinical_assessment) {
    diagnostic_summary = diagnosticData.clinical_assessment.substring(0, 300).trim();
    if (!diagnostic_summary.endsWith('.')) diagnostic_summary += '...';
  }
  if (!diagnostic_summary && diagnosticData.summary) {
    diagnostic_summary = diagnosticData.summary;
  }
  if (!diagnostic_summary) {
    diagnostic_summary = `Cardiovascular risk level: ${diagnosticData.risk_level}. Confidence: ${diagnosticData.confidence_level}%. Full assessment available in clinical details.`;
  }

  // Ensure condition_risk_assessments is always an object (not null/undefined)
  const condition_risk_assessments = diagnosticData.condition_risk_assessments || {};

  // Ensure arrays are always arrays (not null/undefined)
  const risk_factors = Array.isArray(diagnosticData.risk_factors) ? diagnosticData.risk_factors : [];
  const key_findings = Array.isArray(diagnosticData.key_findings) ? diagnosticData.key_findings : [];
  const cardiac_recommendations = Array.isArray(diagnosticData.cardiac_recommendations) ? diagnosticData.cardiac_recommendations : [];
  const lifestyle_modifications = Array.isArray(diagnosticData.lifestyle_modifications) ? diagnosticData.lifestyle_modifications : [];
  const urgent_concerns = Array.isArray(diagnosticData.urgent_concerns) ? diagnosticData.urgent_concerns : [];

  // ─────────────────────────────────────────────────────────────────────────────
  // CONFIDENCE LEVEL POST-PROCESSING
  // ─────────────────────────────────────────────────────────────────────────────
  // Boost confidence based on actual data completeness if Gemini was too conservative
  
  let confidence_level = diagnosticData.confidence_level || 50;
  
  // Calculate data completeness score
  let completenessScore = 50; // Base score
  
  // Add points for data sources (up to 15%)
  if (patientData.feedback) completenessScore += 5;
  if (patientData.report) completenessScore += 5;
  if (ecgData) completenessScore += 5;
  
  // Add points for key data availability (up to 30%)
  let keyDataPoints = 0;
  
  // Check demographics
  if (patientData.report?.age && patientData.report?.gender) keyDataPoints += 5;
  
  // Check vitals
  if (patientData.feedback?.blood_pressure_systolic && patientData.feedback?.blood_pressure_diastolic) keyDataPoints += 5;
  if (patientData.report?.bmi || (patientData.report?.weight && patientData.report?.height)) keyDataPoints += 3;
  
  // Check for symptoms documentation
  if (patientData.feedback && Object.keys(patientData.feedback).length > 5) keyDataPoints += 5;
  
  // Check for labs
  const labsPresent = [
    patientData.report?.lvef,
    patientData.report?.troponin_t,
    patientData.report?.nt_probnp,
    patientData.report?.creatinine
  ].filter(v => v !== null && v !== undefined).length;
  
  if (labsPresent >= 3) keyDataPoints += 7;
  else if (labsPresent >= 1) keyDataPoints += 3;
  
  // Check ECG data completeness
  if (ecgData?.hr_mean !== null) keyDataPoints += 5;
  if (ecgData?.rhythm || ecgData?.abnormalities?.length > 0) keyDataPoints += 3;
  
  completenessScore += Math.min(keyDataPoints, 30);
  
  // Cap at 100
  completenessScore = Math.min(completenessScore, 100);
  
  // If Gemini confidence is significantly lower than data completeness suggests, boost it
  // But don't override if Gemini had good reason to be cautious
  if (confidence_level < completenessScore - 15) {
    confidence_level = completenessScore - 10; // Boost but stay slightly below perfect
    console.log('[buildCompleteReport] Confidence level boosted from Gemini:', diagnosticData.confidence_level, 'to:', confidence_level, '(based on data completeness)');
  }
  
  // Minimum confidence of 40% if we have at least 2 data sources
  const dataSources = [patientData.feedback, patientData.report, ecgData].filter(v => v).length;
  if (dataSources >= 2 && confidence_level < 40) {
    confidence_level = 40;
    console.log('[buildCompleteReport] Minimum confidence applied: 40% (for', dataSources, 'data sources)');
  }

  // Combine all data with safe fallbacks
  return {
    ...diagnosticData,
    confidence_level, // Use potentially boosted confidence level
    demographics,
    vitals,
    labs,
    symptoms,
    ecg_findings,
    prognosis_note,
    diagnostic_summary,
    condition_risk_assessments,
    risk_factors,
    key_findings,
    cardiac_recommendations,
    lifestyle_modifications,
    urgent_concerns
  };
}

async function saveToCloudflare(data, filename) {
  try {
    const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || 'signals-result';
    const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
    const R2_ACCESS_KEY = process.env.R2_ACCESS_KEY;
    const R2_SECRET_KEY = process.env.R2_SECRET_KEY;

    console.log('[saveToCloudflare] Checking R2 credentials...');
    console.log('[saveToCloudflare] R2_BUCKET_NAME:', R2_BUCKET_NAME);
    console.log('[saveToCloudflare] R2_ACCOUNT_ID:', R2_ACCOUNT_ID ? '***configured***' : '***MISSING***');
    console.log('[saveToCloudflare] R2_ACCESS_KEY:', R2_ACCESS_KEY ? '***configured***' : '***MISSING***');
    console.log('[saveToCloudflare] R2_SECRET_KEY:', R2_SECRET_KEY ? '***configured***' : '***MISSING***');

    if (!R2_ACCESS_KEY || !R2_SECRET_KEY || !R2_ACCOUNT_ID) {
      console.error('[saveToCloudflare] Missing R2 credentials - cannot save to Cloudflare');
      console.error('[saveToCloudflare] Required: R2_ACCOUNT_ID, R2_ACCESS_KEY, R2_SECRET_KEY');
      return null;
    }

    // Construct the R2 endpoint
    const endpoint = `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${R2_BUCKET_NAME}/${filename}`;
    console.log('[saveToCloudflare] Endpoint:', endpoint);

    // Create auth header
    const auth = Buffer.from(`${R2_ACCESS_KEY}:${R2_SECRET_KEY}`).toString('base64');
    
    console.log('[saveToCloudflare] Sending PUT request to R2...');
    const response = await fetch(endpoint, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${auth}`
      },
      body: JSON.stringify(data)
    });

    console.log('[saveToCloudflare] Response status:', response.status);
    const responseText = await response.text();
    console.log('[saveToCloudflare] Response body:', responseText.substring(0, 200));

    if (response.ok) {
      const publicUrl = `${CLOUDFLARE_R2_URL}/${filename}`;
      console.log(`[saveToCloudflare] Successfully saved to R2: ${publicUrl}`);
      return publicUrl;
    } else {
      console.error(`[saveToCloudflare] Failed to save to R2: ${response.status} ${response.statusText}`);
      console.error('[saveToCloudflare] Response body:', responseText);
      return null;
    }
  } catch (err) {
    console.error('[saveToCloudflare] Error saving to Cloudflare:', err.message);
    console.error('[saveToCloudflare] Error stack:', err.stack);
    return null;
  }
}

async function handleGenerateDiagnostic(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed - only POST accepted' });
  }

  try {
    await ensureSchema();

    const { patient_id } = req.body;
    if (!patient_id) {
      return res.status(400).json({ error: 'patient_id is required' });
    }

    console.log('[generate-diagnostic] Request for patient:', patient_id);

    // Check if there's a last diagnostic result
    try {
      const lastDiagnosticRes = await sql`
        SELECT id, created_at, generated_at FROM diagnostic_results 
        WHERE patient_id = ${patient_id}
        ORDER BY created_at DESC
        LIMIT 1
      `;
      
      // Get the most recent feedback_form and report_form timestamps
      const feedbackRes = await sql`
        SELECT created_at FROM feedback_form 
        WHERE patient_id = ${patient_id}
        ORDER BY created_at DESC
        LIMIT 1
      `;
      
      const reportRes = await sql`
        SELECT created_at FROM report_form 
        WHERE patient_id = ${patient_id}
        ORDER BY created_at DESC
        LIMIT 1
      `;
      
      const lastFeedbackTimestamp = feedbackRes.rows[0]?.created_at;
      const lastReportTimestamp = reportRes.rows[0]?.created_at;
      const lastDiagnosticTimestamp = lastDiagnosticRes.rows[0]?.created_at;
      
      // If we have a last diagnostic and no newer feedback/report data, return the cached diagnostic
      if (lastDiagnosticTimestamp && 
          (!lastFeedbackTimestamp || new Date(lastFeedbackTimestamp) <= new Date(lastDiagnosticTimestamp)) &&
          (!lastReportTimestamp || new Date(lastReportTimestamp) <= new Date(lastDiagnosticTimestamp))) {
        
        console.log('[generate-diagnostic] No changes in feedback or report data since last diagnostic');
        console.log('[generate-diagnostic] Last diagnostic timestamp:', lastDiagnosticTimestamp);
        console.log('[generate-diagnostic] Last feedback timestamp:', lastFeedbackTimestamp);
        console.log('[generate-diagnostic] Last report timestamp:', lastReportTimestamp);
        console.log('[generate-diagnostic] Returning cached diagnostic result');
        
        // Get the full diagnostic result from the database
        const cachedDiagnosticRes = await sql`
          SELECT * FROM diagnostic_results 
          WHERE patient_id = ${patient_id}
          ORDER BY created_at DESC
          LIMIT 1
        `;
        
        if (cachedDiagnosticRes.rows.length > 0) {
          const cached = cachedDiagnosticRes.rows[0];
          
          // Reconstruct report object from database columns
          const cachedReport = {
            patient_id: cached.patient_id,
            generated_at: cached.generated_at,
            data_sources: {
              feedback_form: cached.has_feedback_data,
              report_form: cached.has_report_data,
              ecg_analysis: cached.has_ecg_data
            },
            risk_level: cached.risk_level,
            risk_percentage: cached.risk_percentage,
            condition_risk_assessments: cached.condition_risk_assessments,
            clinical_assessment: cached.clinical_assessment,
            detailed_recommendations: cached.detailed_recommendations,
            risk_factors: cached.risk_factors,
            key_findings: cached.key_findings,
            cardiac_recommendations: cached.cardiac_recommendations,
            lifestyle_modifications: cached.lifestyle_modifications,
            monitoring_plan: cached.monitoring_plan,
            follow_up_timeline: cached.follow_up_timeline,
            urgent_concerns: cached.urgent_concerns,
            confidence_level: cached.confidence_level,
            summary: cached.summary,
            ecg_findings: cached.ecg_findings,
            vitals: cached.vitals,
            labs: cached.labs,
            demographics: cached.demographics,
            symptoms: cached.symptoms,
            prognosis_note: cached.prognosis_note,
            diagnostic_summary: cached.diagnostic_summary
          };
          
          // Try to fetch multi_ai_diagnostics from Cloudflare if available
          let multiAIDiagnostics = null;
          if (cached.cloudflare_json_url) {
            try {
              console.log('[generate-diagnostic] Fetching multi-AI data from Cloudflare...');
              const cloudflareResponse = await fetch(cached.cloudflare_json_url);
              if (cloudflareResponse.ok) {
                const fullReportFromCloudflare = await cloudflareResponse.json();
                multiAIDiagnostics = fullReportFromCloudflare.multi_ai_diagnostics;
                if (multiAIDiagnostics) {
                  cachedReport.multi_ai_diagnostics = multiAIDiagnostics;
                }
              }
            } catch (cfErr) {
              console.warn('[generate-diagnostic] Could not fetch multi-AI data from Cloudflare:', cfErr.message);
            }
          }
          
          return res.status(200).json({
            success: true,
            cached: true,
            data_unchanged: true,
            report: cachedReport,
            cloudflare_json_url: cached.cloudflare_json_url,
            generated_at: cached.generated_at,
            message: 'No changes detected in feedback or report forms - returning last diagnostic result'
          });
        }
      }
      
      console.log('[generate-diagnostic] Changes detected or no previous diagnostic - generating new diagnostic');
      console.log('[generate-diagnostic] Last diagnostic timestamp:', lastDiagnosticTimestamp);
      console.log('[generate-diagnostic] Last feedback timestamp:', lastFeedbackTimestamp);
      console.log('[generate-diagnostic] Last report timestamp:', lastReportTimestamp);
      
    } catch (cacheErr) {
      console.warn('[generate-diagnostic] Error checking data changes:', cacheErr.message);
      // Continue to generate new diagnostic
    }

    if (!GEMINI_API_KEY) {
      console.error('[generate-diagnostic] GEMINI_API_KEY not configured');
      return res.status(500).json({
        error: 'GEMINI_API_KEY not configured in environment',
        details: 'Please add GEMINI_API_KEY to Vercel environment variables'
      });
    }

    console.log('[generate-diagnostic] Fetching patient data...');
    const patientData = await fetchPatientData(patient_id);
    
    console.log('[generate-diagnostic] Fetching ECG results from Cloudflare...');
    const ecgData = await fetchECGResults();

    console.log('[generate-diagnostic] Generating diagnostic report with Gemini...');
    const diagnosticReport = await generateDiagnosticReport(patientData, ecgData);

    // Build complete report with both Gemini data AND patient demographics/vitals/labs
    const fullReport = {
      patient_id,
      generated_at: new Date().toISOString(),
      data_sources: {
        feedback_form: patientData.feedback !== null,
        report_form: patientData.report !== null,
        ecg_analysis: ecgData !== null
      },
      ...buildCompleteReport(diagnosticReport, patientData, ecgData)
    };

    console.log('[generate-diagnostic] Report generated successfully, risk level:', fullReport.risk_level);
    console.log('[generate-diagnostic] Report has ecg_findings:', !!fullReport.ecg_findings);
    console.log('[generate-diagnostic] Report has prognosis_note:', !!fullReport.prognosis_note);
    console.log('[generate-diagnostic] Data sources available - feedback:', fullReport.data_sources.feedback_form, 'report:', fullReport.data_sources.report_form, 'ecg:', fullReport.data_sources.ecg_analysis);

    // Generate multi-AI comparison (Gemini, Claude)
    let multiAIResults = null;
    try {
      console.log('[generate-diagnostic] Generating multi-AI diagnostics (Gemini + Claude)...');
      multiAIResults = await generateMultiAIDiagnostic(patientData, ecgData, diagnosticReport);
      
      // Check if multi-AI is available
      if (!multiAIResults.multiAIAvailable) {
        console.warn('[generate-diagnostic]  Multi-AI diagnostics not fully available');
        console.warn('[generate-diagnostic] Missing API keys - set CLAUDE_API_KEY to enable');
      }
      
      // Add multi-AI results to full report
      fullReport.multi_ai_diagnostics = {
        gemini_result: multiAIResults.gemini_result,
        claude_result: multiAIResults.claude_result,
        agreement_score: multiAIResults.agreement_score,
        consensus_risk_level: multiAIResults.consensus_risk_level,
        consensus_risk_percentage: multiAIResults.consensus_risk_percentage,
        models_agreement: multiAIResults.models_agreement,
        comparison_analysis: multiAIResults.comparison_analysis,
        errors: multiAIResults.errors,
        multiAIAvailable: multiAIResults.multiAIAvailable
      };
      
      if (multiAIResults.agreement_score !== undefined) {
        console.log('[generate-diagnostic] Multi-AI diagnostics generated');
        console.log('[generate-diagnostic] Agreement score:', multiAIResults.agreement_score, '%');
        console.log('[generate-diagnostic] Consensus risk:', multiAIResults.consensus_risk_level);
      } else {
        console.warn('[generate-diagnostic] Multi-AI comparison skipped (insufficient models available)');
        fullReport.multi_ai_message = 'Multi-AI comparison not available. Please configure CLAUDE_API_KEY.';
      }
    } catch (multiAIErr) {
      console.error('[generate-diagnostic] Multi-AI generation error:', multiAIErr.message);
      // Don't fail the entire diagnostic if multi-AI fails
      fullReport.multi_ai_error = multiAIErr.message;
      fullReport.multi_ai_message = 'Multi-AI diagnostics failed. Gemini diagnostic is available.';
    }

    // Save to Cloudflare R2
    const timestamp = Date.now();
    const r2Filename = `diagnostics/diagnostic_${patient_id}_${timestamp}.json`;
    const cloudflarePath = await saveToCloudflare(fullReport, r2Filename);

    // Add cloudflare URL to the report data before saving to DB
    fullReport.cloudflare_json_url = cloudflarePath;

    // Save to database
    try {
      await saveDiagnosticResult(patient_id, fullReport);
      console.log('[generate-diagnostic] Diagnostic saved to database and R2');

      // Calculate and store GRACE-3 score
      try {
        const patientData = await fetchPatientData(patient_id);
        const ecgData = fullReport.ecg_findings || null;
        const grace3Result = await calculateAndStoreGRACE3Score(sql, patient_id, patientData, ecgData);
        if (grace3Result.calculated) {
          console.log('[generate-diagnostic] GRACE-3 score calculated:', grace3Result.result.score);
          fullReport.grace3_score = grace3Result.result;
        } else {
          console.log('[generate-diagnostic] GRACE-3 calculation skipped:', grace3Result.reason);
        }
      } catch (grace3Err) {
        console.error('[generate-diagnostic] GRACE-3 calculation error:', grace3Err.message);
        // Don't fail the entire diagnostic if GRACE-3 fails
      }
    } catch (dbErr) {
      console.error('[generate-diagnostic] Error saving to database:', dbErr.message);
      // Still return the report even if DB save fails
    }

    return res.status(200).json({
      success: true,
      cached: false,
      report: fullReport,
      cloudflare_json_url: cloudflarePath,
      generated_at: fullReport.generated_at
    });

  } catch (err) {
    console.error('[generate-diagnostic] Error:', {
      message: err.message,
      code: err.code,
      stack: err.stack
    });
    
    return res.status(500).json({
      error: 'Failed to generate diagnostic report',
      details: err.message,
      type: err.name
    });
  }
}

// SAVE DIAGNOSTIC RESULTS
// TODO(voice-agent): this endpoint used to be called by the n8n workflow after it ran
// Gemini/Claude diagnostic generation. Whatever replaces n8n's orchestration (Stage 2+)
// should keep POSTing here, or this should be called directly from that new pipeline.

async function handleSaveDiagnostic(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed - only POST accepted' });
  }

  try {
    await ensureSchema();

    const {
      patient_id,
      generated_at,
      report_version,
      analysis_model,
      risk_level,
      risk_percentage,
      condition_risk_assessments,
      clinical_assessment,
      detailed_recommendations,
      risk_factors,
      key_findings,
      cardiac_recommendations,
      lifestyle_modifications,
      monitoring_plan,
      follow_up_timeline,
      urgent_concerns,
      confidence_level,
      summary,
      diagnostic_summary,
      prognosis_note,
      data_sources,
      ecg_findings,
      vitals,
      labs,
      demographics,
      symptoms,
      cloudflare_html_url,
      cloudflare_json_url
    } = req.body;

    if (!patient_id) {
      return res.status(400).json({
        error: 'patient_id is required',
        received: { patient_id }
      });
    }

    console.log('[save-diagnostic] Saving diagnostic result for patient:', patient_id);

    const diagnosticData = {
      generated_at: generated_at || new Date().toISOString(),
      report_version: report_version || '1.7',
      analysis_model: analysis_model || 'Gemini 2.0',
      risk_level,
      risk_percentage,
      condition_risk_assessments,
      clinical_assessment,
      detailed_recommendations,
      risk_factors,
      key_findings,
      cardiac_recommendations,
      lifestyle_modifications,
      monitoring_plan,
      follow_up_timeline,
      urgent_concerns,
      confidence_level,
      summary,
      diagnostic_summary,
      prognosis_note,
      data_sources: data_sources || {},
      ecg_findings,
      vitals,
      labs,
      demographics,
      symptoms,
      cloudflare_html_url,
      cloudflare_json_url
    };

    const savedResult = await saveDiagnosticResult(patient_id, diagnosticData);

    console.log('[save-diagnostic] Successfully saved diagnostic result with ID:', savedResult.id);
    console.log('[save-diagnostic] Risk level:', savedResult.risk_level);
    console.log('[save-diagnostic] Confidence:', savedResult.confidence_level);

    // Calculate and store GRACE-3 score
    try {
      const patientData = await fetchPatientData(patient_id);
      const ecgData = diagnosticData.ecg_findings || null;
      const grace3Result = await calculateAndStoreGRACE3Score(sql, patient_id, patientData, ecgData);
      if (grace3Result.calculated) {
        console.log('[save-diagnostic] GRACE-3 score calculated:', grace3Result.result.score);
      } else {
        console.log('[save-diagnostic] GRACE-3 calculation skipped:', grace3Result.reason);
      }
    } catch (grace3Err) {
      console.error('[save-diagnostic] GRACE-3 calculation error:', grace3Err.message);
      // Don't fail the entire save if GRACE-3 fails
    }

    return res.status(201).json({
      success: true,
      message: 'Diagnostic result saved successfully',
      diagnostic_result_id: savedResult.id,
      patient_id,
      risk_level: savedResult.risk_level,
      risk_percentage: savedResult.risk_percentage,
      created_at: savedResult.created_at
    });

  } catch (err) {
    console.error('[save-diagnostic] Error:', {
      message: err.message,
      code: err.code,
      details: err.details,
      stack: err.stack
    });

    return res.status(500).json({
      error: 'Failed to save diagnostic result',
      details: err.message,
      type: err.name
    });
  }
}

// CALCULATE GRACE-3 SCORE ON-DEMAND (for missing scores)

async function handleCalculateGRACE3(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    await ensureSchema();

    const auth = requireAuth(req);
    if (!auth) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    const { patient_id } = body;

    if (!patient_id) {
      return res.status(400).json({ error: 'patient_id is required' });
    }

    // Allow doctor to calculate for patient, patient can only calculate own
    let patientId = auth.sub;
    if (patient_id && auth.role === 'doctor') {
      patientId = Number(patient_id);
    } else if (patient_id) {
      patientId = Number(patient_id);
    }

    console.log('[calculate-grace3] Calculating GRACE-3 for patient:', patientId);

    // Fetch latest diagnostic result
    const diagnosticRes = await sql`
      SELECT * FROM diagnostic_results
      WHERE patient_id = ${patientId}
      ORDER BY created_at DESC
      LIMIT 1
    `;

    const diagnostic = diagnosticRes.rows[0];
    if (!diagnostic) {
      return res.status(404).json({ error: 'No diagnostic found for patient' });
    }

    // Fetch ECG results to get heart rate data
    console.log('[calculate-grace3] Fetching ECG results from Cloudflare R2...');
    let ecgData = null;
    try {
      const ecgResults = await fetchECGResults();
      if (ecgResults && ecgResults.metrics) {
        ecgData = ecgResults;
        console.log('[calculate-grace3] ECG data loaded:', {
          hr_mean: ecgResults.metrics?.heart_rate_mean || ecgResults.metrics?.hr_mean,
          hr_std: ecgResults.metrics?.heart_rate_std
        });
      }
    } catch (ecgErr) {
      console.warn('[calculate-grace3] Could not fetch ECG data:', ecgErr.message);
    }

    // Extract GRACE-3 parameters from diagnostic data
    // Try multiple locations for each field since data structure may vary
    
    // Try to extract age
    const age = diagnostic.age || 
                diagnostic.demographics?.age || 
                diagnostic.report?.age || 
                null;

    // Try to extract heart rate (check ECG data first, then diagnostic)
    const heart_rate = diagnostic.heart_rate || 
                       diagnostic.vitals?.heart_rate || 
                       diagnostic.ecg_findings?.hr_mean || 
                       diagnostic.ecg_findings?.heart_rate ||
                       diagnostic.heartRate ||
                       ecgData?.metrics?.heart_rate_mean ||
                       ecgData?.metrics?.hr_mean ||
                       ecgData?.hr_mean ||
                       null;

    // Try to extract systolic BP
    const systolic_bp = diagnostic.systolic_bp || 
                        diagnostic.blood_pressure_systolic ||
                        diagnostic.vitals?.systolic || 
                        diagnostic.vitals?.blood_pressure_systolic ||
                        null;

    // Try to extract creatinine
    const creatinine = diagnostic.creatinine || 
                       diagnostic.labs?.creatinine || 
                       null;

    // Try to extract gender/sex
    const gender = diagnostic.gender || 
                   diagnostic.sex ||
                   diagnostic.demographics?.gender || 
                   null;
    
    const sex = gender ? gender.charAt(0).toUpperCase() : null;

    // Extract optional parameters
    const cardiac_arrest = diagnostic.cardiac_arrest === 'Yes' || 
                           diagnostic.vitals?.cardiac_arrest === 'Yes' ||
                           false;
    
    const st_deviation = diagnostic.st_deviation || 
                         diagnostic.ecg_findings?.st_elevation || 
                         diagnostic.ecg_findings?.st_depression ||
                         false;
    
    // Convert numeric troponin values to boolean (yes/no) based on clinical thresholds
    // Normal thresholds: Troponin T < 0.03 ng/mL, Troponin I < 0.04 ng/mL
    let troponin_elevation = false;
    const troponinT = diagnostic.troponin_elevation || 
                      diagnostic.labs?.troponinT || 
                      diagnostic.troponin_t ||
                      null;
    const troponinI = diagnostic.labs?.troponinI || 
                      diagnostic.troponin_i ||
                      null;
    
    // Check if either troponin value is elevated (above threshold)
    if (troponinT) {
      const tValue = parseFloat(troponinT);
      if (!isNaN(tValue) && tValue >= 0.03) {
        troponin_elevation = true;
      }
    }
    
    if (troponinI) {
      const iValue = parseFloat(troponinI);
      if (!isNaN(iValue) && iValue >= 0.04) {
        troponin_elevation = true;
      }
    }
    
    // If still false, check if it's explicitly marked as 'Yes'
    if (!troponin_elevation && (
        diagnostic.troponin_elevation === 'Yes' || 
        diagnostic.labs?.troponin_elevation === 'Yes'
    )) {
      troponin_elevation = true;
    }

    const params = {
      age,
      heart_rate,
      systolic_bp,
      creatinine,
      sex,
      cardiac_arrest,
      st_deviation,
      troponin_elevation,
      killip_class: parseInt(diagnostic.killip_class || diagnostic.demographics?.nyha) || 1
    };

    console.log('[calculate-grace3] Extracted parameters:', params);
    console.log('[calculate-grace3] Available diagnostic fields:', Object.keys(diagnostic).slice(0, 20));
    console.log('[calculate-grace3] ECG data available:', ecgData ? 'YES' : 'NO');
    console.log('[calculate-grace3] Troponin elevation (converted to boolean):', troponin_elevation, '(Raw troponinT:', troponinT, ', Raw troponinI:', troponinI, ')');

    // Check if we have minimum required data
    if (!age || !heart_rate || !systolic_bp || !creatinine || !sex) {
      console.warn('[calculate-grace3] Insufficient data for GRACE-3 calculation');
      console.warn('[calculate-grace3] Missing or invalid:', {
        age: age || 'MISSING',
        heart_rate: heart_rate || 'MISSING',
        systolic_bp: systolic_bp || 'MISSING',
        creatinine: creatinine || 'MISSING',
        sex: sex || 'MISSING'
      });
      console.warn('[calculate-grace3] Heart rate search locations checked:');
      console.warn('  - diagnostic.heart_rate:', diagnostic.heart_rate);
      console.warn('  - diagnostic.vitals?.heart_rate:', diagnostic.vitals?.heart_rate);
      console.warn('  - diagnostic.ecg_findings?.hr_mean:', diagnostic.ecg_findings?.hr_mean);
      console.warn('  - ecgData?.metrics?.heart_rate_mean:', ecgData?.metrics?.heart_rate_mean);
      console.warn('  - ecgData?.metrics?.hr_mean:', ecgData?.metrics?.hr_mean);
      return res.status(400).json({
        error: 'Insufficient data for GRACE-3 calculation',
        found: {
          age: age || 'MISSING',
          heart_rate: heart_rate || 'MISSING',
          systolic_bp: systolic_bp || 'MISSING',
          creatinine: creatinine || 'MISSING',
          sex: sex || 'MISSING'
        },
        required: ['age', 'heart_rate', 'systolic_bp', 'creatinine', 'sex'],
        sources_checked: {
          diagnostic_data: !!diagnostic.heart_rate,
          diagnostic_vitals: !!diagnostic.vitals?.heart_rate,
          ecg_findings: !!diagnostic.ecg_findings?.hr_mean,
          r2_ecg_data: ecgData ? `hr_mean=${ecgData.metrics?.heart_rate_mean || ecgData.metrics?.hr_mean}` : 'NOT_FOUND'
        }
      });
    }

    // Calculate GRACE-3 score
    const result = calculateGRACE3Score(params);

    if (result.score === null) {
      return res.status(400).json({ error: 'Failed to calculate GRACE-3 score' });
    }

    // Update diagnostic record with GRACE-3 data
    await sql`
      UPDATE diagnostic_results
      SET
        grace3_score = ${result.score},
        grace3_mortality_6month = ${result.mortality_6month},
        grace3_major_adverse_event_6month = ${result.major_adverse_event_6month},
        grace3_risk_category = ${result.risk_category},
        grace3_parameters = ${JSON.stringify(result.parameters)},
        grace3_components = ${JSON.stringify(result.components)},
        grace3_calculated_at = NOW()
      WHERE id = ${diagnostic.id}
    `;

    console.log('[calculate-grace3] GRACE-3 score calculated and saved:', result.score);

    return res.status(200).json({
      success: true,
      grace3_score: result.score,
      grace3_mortality_6month: result.mortality_6month,
      grace3_major_adverse_event_6month: result.major_adverse_event_6month,
      grace3_risk_category: result.risk_category,
      grace3_parameters: result.parameters,
      grace3_components: result.components
    });

  } catch (err) {
    console.error('[calculate-grace3] Error:', err);
    return res.status(500).json({
      error: 'Failed to calculate GRACE-3',
      details: err.message
    });
  }
}

// GET ALL REPORTS (Fetch reports, feedback, p1forms, diagnostics)

async function handleGetReports(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    await ensureSchema();
    
    const auth = requireAuth(req);
    if (!auth) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Allow doctor to view by patientId, otherwise patient can only view own
    const url = new URL(req.url, 'http://localhost');
    // Accept both 'patientId' and 'patient_id' query parameters
    const patientIdParam = url.searchParams.get('patientId') || url.searchParams.get('patient_id');
    let patientId = auth.sub;
    
    if (patientIdParam && auth.role === 'doctor') {
      patientId = Number(patientIdParam);
    }

    console.log(`[get-reports] Fetching reports for patient ${patientId}`);

    const [doctorReports, patientFeedback, p1forms, diagnosticResults] = await Promise.all([
      getPatientReports(patientId),
      getFeedbackFormByPatient(patientId),
      getP1ReportFormByPatient(patientId),
      getDiagnosticResultsByPatient(patientId)
    ]);

    console.log(`[get-reports] Retrieved: ${doctorReports.length} reports, ${patientFeedback.length} feedback, ${p1forms.length} forms, ${diagnosticResults.length} diagnostics`);

    return res.status(200).json({
      reports: doctorReports,
      feedback: patientFeedback,
      p1forms,
      diagnostics: diagnosticResults,
      items: diagnosticResults
    });

  } catch (err) {
    console.error('[get-reports] Error:', err);
    return res.status(500).json({
      error: 'Failed to fetch reports',
      details: err.message
    });
  }
}

// MAIN ROUTER
export default async function handler(req, res) {
  // Extract route from URL path directly
  // URL format: /api/diagnostic/generate-diagnostic or /api/diagnostic/save-diagnostic
  const urlPath = req.url || '';
  const match = urlPath.match(/\/api\/diagnostic\/([^/?]+)/);
  const route = match ? match[1] : '';

  console.log('[diagnostic router] Request:', req.method, req.url);
  console.log('[diagnostic router] Extracted route:', route);

  // Handle GET requests (retrieve reports)
  if (req.method === 'GET' && !route) {
    console.log('[diagnostic router] Routing to get-reports handler');
    return handleGetReports(req, res);
  }

  // Handle POST requests (generate/save/calculate diagnostics)
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // Route to appropriate handler
  if (route === 'generate-diagnostic') {
    console.log('[diagnostic router] Routing to generate-diagnostic handler');
    return handleGenerateDiagnostic(req, res);
  } else if (route === 'save-diagnostic') {
    console.log('[diagnostic router] Routing to save-diagnostic handler');
    return handleSaveDiagnostic(req, res);
  } else if (route === 'calculate-grace3') {
    console.log('[diagnostic router] Routing to calculate-grace3 handler');
    return handleCalculateGRACE3(req, res);
  } else {
    console.log('[diagnostic router] No matching route for:', route);
    return res.status(404).json({ error: 'Route not found', received_route: route });
  }
}







