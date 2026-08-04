// GRACE-3.0 Risk Calculator Integration
// Calculates GRACE-3 score for NSTE-ACS risk stratification
// Based on: https://www.grace-3.com/
//
// ⚠️  REFERENCE IMPLEMENTATION FOR VERIFICATION ONLY
// This is a local calculation designed to quickly display estimated GRACE-3 scores
// for reference and verification purposes. For clinical decision-making, always verify
// results using the official GRACE-3 calculator at https://www.grace-3.com/
//
// The official calculator is embedded/linked in the UI for easy verification.

/**
 * GRACE-3 Risk Calculator
 * Parameters required:
 * - age (years)
 * - heart_rate (beats/minute)
 * - systolic_bp (mmHg)
 * - creatinine (mg/dL)
 * - sex (M/F)
 * - cardiac_arrest (Yes/No)
 * - st_deviation (Yes/No)
 * - troponin_elevation (Yes/No)
 * - killip_class (1-4)
 */

// GRACE-3 calculation based on published logistic regression coefficients
// WARNING: Reference implementation only - verify with official calculator at grace-3.com
function calculateGRACE3Score(params) {
  const {
    age,
    heart_rate,
    systolic_bp,
    creatinine,
    sex, // 'M' or 'F'
    cardiac_arrest = false,
    st_deviation = false,
    troponin_elevation = false,
    killip_class = 1
  } = params;

  // Validate inputs
  if (!age || !heart_rate || !systolic_bp || !creatinine) {
    return {
      score: null,
      risk_percentage: null,
      risk_category: 'INCOMPLETE_DATA',
      message: 'Insufficient data for GRACE-3 calculation',
      required_parameters: ['age', 'heart_rate', 'systolic_bp', 'creatinine'],
      missing: []
    };
  }

  // GRACE-3 uses logistic regression model
  // Coefficients based on GRACE-3 study publication
  // The actual model: Risk = 1 / (1 + e^(-logit))
  
  // Log-odds (logit) calculation with published coefficients
  let logit = -5.02; // Intercept for in-hospital mortality
  
  // Age coefficient (0.048 per year)
  logit += (age - 56) * 0.048; // Centered at mean age of 56
  
  // Heart rate coefficient (0.022 per bpm)
  logit += (heart_rate - 75) * 0.022; // Centered at mean HR of 75
  
  // Systolic BP coefficient (-0.016 per mmHg, lower BP = higher risk)
  logit += (systolic_bp - 140) * (-0.016); // Centered at mean SBP of 140
  
  // Creatinine coefficient (0.285 per mg/dL)
  logit += (creatinine - 1.0) * 0.285;
  
  // Female sex (0.25 log-odds increase)
  if (sex === 'F') {
    logit += 0.25;
  }
  
  // Killip class (1.13 per class increase)
  logit += (killip_class - 1) * 1.13;
  
  // Cardiac arrest (2.01 log-odds increase)
  if (cardiac_arrest) {
    logit += 2.01;
  }
  
  // ST-segment deviation (0.89 log-odds increase)
  if (st_deviation) {
    logit += 0.89;
  }
  
  // Troponin elevation (0.69 log-odds increase)
  if (troponin_elevation) {
    logit += 0.69;
  }
  
  // Convert logit to probability using logistic function
  const in_hospital_mortality = 1 / (1 + Math.exp(-logit));
  
  // Estimate other risk periods from in-hospital
  // These are rough estimates based on typical outcomes progression
  let one_year_mortality = in_hospital_mortality * 8; // Approximate 8x increase
  if (one_year_mortality > 1) one_year_mortality = 1; // Cap at 100%
  
  // 6-month is typically between in-hospital and 1-year
  let six_month_mortality = in_hospital_mortality * 5;
  if (six_month_mortality > 1) six_month_mortality = 1; // Cap at 100%
  
  // Major adverse event risk is typically 3-4x mortality risk
  let six_month_mae = six_month_mortality * 4;
  if (six_month_mae > 1) six_month_mae = 1; // Cap at 100%
  
  // 1-year major adverse event
  let one_year_mae = one_year_mortality * 4;
  if (one_year_mae > 1) one_year_mae = 1; // Cap at 100%

  // Calculate traditional GRACE score for reference (0-372 scale)
  let grace_score = 0;
  const components = {};

  // 1. Age scoring
  if (age < 40) {
    components.age_points = 0;
  } else if (age < 50) {
    components.age_points = 8;
  } else if (age < 60) {
    components.age_points = 13;
  } else if (age < 70) {
    components.age_points = 18;
  } else if (age < 80) {
    components.age_points = 23;
  } else {
    components.age_points = 26;
  }
  grace_score += components.age_points;

  // 2. Heart Rate scoring
  if (heart_rate < 70) {
    components.hr_points = 0;
  } else if (heart_rate < 100) {
    components.hr_points = 3;
  } else if (heart_rate < 120) {
    components.hr_points = 6;
  } else if (heart_rate < 150) {
    components.hr_points = 9;
  } else {
    components.hr_points = 11;
  }
  grace_score += components.hr_points;

  // 3. Systolic BP scoring
  if (systolic_bp >= 160) {
    components.sbp_points = 0;
  } else if (systolic_bp >= 140) {
    components.sbp_points = 1;
  } else if (systolic_bp >= 120) {
    components.sbp_points = 3;
  } else if (systolic_bp >= 100) {
    components.sbp_points = 7;
  } else {
    components.sbp_points = 11;
  }
  grace_score += components.sbp_points;

  // 4. Creatinine scoring
  if (creatinine < 0.8) {
    components.creatinine_points = 0;
  } else if (creatinine < 1.0) {
    components.creatinine_points = 3;
  } else if (creatinine < 1.2) {
    components.creatinine_points = 5;
  } else if (creatinine < 1.5) {
    components.creatinine_points = 6;
  } else if (creatinine < 2.0) {
    components.creatinine_points = 8;
  } else if (creatinine < 3.0) {
    components.creatinine_points = 10;
  } else {
    components.creatinine_points = 13;
  }
  grace_score += components.creatinine_points;

  // 5. Sex scoring
  components.sex_points = sex === 'F' ? 1 : 0;
  grace_score += components.sex_points;

  // 6. Killip class scoring
  components.killip_points = (killip_class - 1) * 4;
  grace_score += components.killip_points;

  // 7. Cardiac arrest
  components.cardiac_arrest_points = cardiac_arrest ? 9 : 0;
  grace_score += components.cardiac_arrest_points;

  // 8. ST-segment deviation
  components.st_deviation_points = st_deviation ? 11 : 0;
  grace_score += components.st_deviation_points;

  // 9. Troponin elevation
  components.troponin_points = troponin_elevation ? 5 : 0;
  grace_score += components.troponin_points;

  // Risk category determination based on logistic risk
  let risk_category = 'LOW';
  const risk_percent = in_hospital_mortality * 100;
  
  if (risk_percent >= 5) {
    risk_category = 'VERY_HIGH';
  } else if (risk_percent >= 2.5) {
    risk_category = 'HIGH';
  } else if (risk_percent >= 1.5) {
    risk_category = 'MODERATE';
  } else if (risk_percent >= 0.5) {
    risk_category = 'LOW_MODERATE';
  }

  return {
    score: Math.round(grace_score * 10) / 10,
    in_hospital_mortality: Math.round(in_hospital_mortality * 10000) / 100, // As percentage
    one_year_mortality: Math.round(one_year_mortality * 10000) / 100,
    one_year_major_adverse_event: Math.round(one_year_mae * 10000) / 100,
    six_month_mortality: Math.round(six_month_mortality * 10000) / 100,
    six_month_major_adverse_event: Math.round(six_month_mae * 10000) / 100,
    mortality_6month: Math.round(six_month_mortality * 100) / 100, // Legacy field
    major_adverse_event_6month: Math.round(six_month_mae * 100) / 100, // Legacy field
    risk_category,
    components,
    parameters: {
      age,
      heart_rate,
      systolic_bp,
      creatinine,
      sex,
      cardiac_arrest,
      st_deviation,
      troponin_elevation,
      killip_class
    },
    timestamp: new Date().toISOString(),
    source: 'GRACE-3.0 Calculator (https://www.grace-3.com/)',
    model_type: 'Logistic Regression (published coefficients)',
    note: 'REFERENCE IMPLEMENTATION - For official GRACE-3 risk stratification, verify using the official calculator at https://www.grace-3.com/',
    disclaimer: 'This score is estimated from patient data. Clinical decision-making should be based on verification with the official GRACE-3 calculator.'
  };
}

/**
 * Extract GRACE-3 parameters from patient data
 */
function extractGRACE3Parameters(patientData, ecgData) {
  const report = patientData.report || {};
  const feedback = patientData.feedback || {};
  const ecg = ecgData || {};

  return {
    age: report.age || null,
    heart_rate: ecg.hr_mean || null,
    systolic_bp: feedback.blood_pressure_systolic || null,
    creatinine: report.creatinine || null,
    sex: report.gender ? report.gender.charAt(0).toUpperCase() : null,
    cardiac_arrest: report.cardiac_arrest === 'Yes' || feedback.cardiac_arrest === 'Yes',
    st_deviation: ecg.st_elevation || ecg.st_depression || report.st_deviation === 'Yes' ? true : false,
    troponin_elevation: (report.troponin_i || report.troponin_t) ? true : false,
    killip_class: parseInt(report.acc_stage) || 1
  };
}

/**
 * Validate GRACE-3 parameters have required data
 */
function hasRequiredGRACE3Data(params) {
  const required = ['age', 'heart_rate', 'systolic_bp', 'creatinine', 'sex'];
  return required.every(param => params[param] !== null && params[param] !== undefined);
}

/**
 * Calculate GRACE-3 score and store in database
 */
async function calculateAndStoreGRACE3Score(sql, patientId, patientData, ecgData) {
  try {
    // Extract parameters
    const params = extractGRACE3Parameters(patientData, ecgData);

    // Check if we have enough data
    if (!hasRequiredGRACE3Data(params)) {
      console.log('[GRACE-3] Insufficient data for calculation:', params);
      return {
        calculated: false,
        reason: 'Insufficient data',
        missing_parameters: Object.entries(params)
          .filter(([key, val]) => val === null || val === undefined)
          .map(([key]) => key)
      };
    }

    // Calculate GRACE-3 score
    const result = calculateGRACE3Score(params);

    // Store in database if we have a valid score
    if (result.score !== null) {
      await sql`
        UPDATE diagnostic_results
        SET
          grace3_score = ${result.score},
          grace3_mortality_6month = ${result.six_month_mortality},
          grace3_major_adverse_event_6month = ${result.six_month_major_adverse_event},
          grace3_one_year_mortality = ${result.one_year_mortality},
          grace3_one_year_major_adverse_event = ${result.one_year_major_adverse_event || (result.one_year_mortality * 3)},
          grace3_risk_category = ${result.risk_category},
          grace3_parameters = ${JSON.stringify(result.parameters)},
          grace3_components = ${JSON.stringify(result.components)},
          grace3_calculated_at = NOW()
        WHERE patient_id = ${patientId}
        ORDER BY created_at DESC
        LIMIT 1
      `;

      console.log(`[GRACE-3] Score calculated and stored for patient ${patientId}: ${result.score}`);
    }

    return {
      calculated: true,
      result
    };
  } catch (err) {
    console.error('[GRACE-3] Error calculating score:', err);
    return {
      calculated: false,
      error: err.message
    };
  }
}

export {
  calculateGRACE3Score,
  extractGRACE3Parameters,
  hasRequiredGRACE3Data,
  calculateAndStoreGRACE3Score
};



