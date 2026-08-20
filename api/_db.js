

import { sql } from '@vercel/postgres';
import bcrypt from 'bcryptjs';

export async function ensureSchema() {
  //  Users 
  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id serial PRIMARY KEY,
      full_name text NOT NULL,
      username text UNIQUE NOT NULL,
      password_hash text NOT NULL,
      role text NOT NULL CHECK (role IN ('doctor','patient')),
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `;

  // TODO(voice-agent): chat_memory table removed — it was n8n's own conversation-memory
  // store (written directly by n8n's Postgres/memory node, not through this API). If the
  // new Claude/Pipecat agent needs persisted session memory, design that storage in
  // Stage 2+ rather than reusing this table.

  //  Doctor Reports
  await sql`
    CREATE TABLE IF NOT EXISTS reports (
      id serial PRIMARY KEY,
      patient_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      doctor_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      sick_status text,
      notes text,
      diagnosis text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS feedback_form (
      id serial PRIMARY KEY,
      patient_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now(),
      dyspnea text,
      orthopnea text,
      paroxysmal_nocturnal_dyspnea text,
      cyanosis text,
      jugular_venous_distension text,
      nighttime_urination_count integer,
      chest_pain text,
      arm_pain text,
      leg_pain text,
      jaw_pain text,
      back_pain text,
      stomach_pain text,
      headache text,
      numb_arms_legs text,
      visual_disturbances text,
      palpitations text,
      sweating text,
      leg_swelling text,
      abdominal_bloating text,
      weight_kg numeric,
      walk_6min_distance_m numeric,
      blood_pressure_systolic integer,
      blood_pressure_diastolic integer,
      fatigue_level integer,
      sleep_quality integer,
      anxious text,
      erectile_dysfunction text,
      free_comment text,
      free_text text,
      source text NOT NULL DEFAULT 'voice' CHECK (source IN ('manual', 'voice')),
      feedback_date date NOT NULL DEFAULT CURRENT_DATE,
      CONSTRAINT feedback_form_one_per_day UNIQUE (patient_id, feedback_date)
    );
  `;

  // Migration: older deployments created feedback_form before free_text existed.
  // (Superseded by the per-question `<column>_free_text` columns below — left in
  // place, unused, rather than dropping a column that may already hold data.)
  await sql`ALTER TABLE feedback_form ADD COLUMN IF NOT EXISTS free_text text;`;

  // Migration: one `<column>_free_text` companion per daily-feedback column, so an
  // AI follow-up answer is stored right next to the structured answer it clarifies
  // instead of in one shared blob.
  for (const column of new Set(Object.values(QUESTION_ID_MAP))) {
    await sql.query(`ALTER TABLE feedback_form ADD COLUMN IF NOT EXISTS ${column}_free_text text;`);
  }

  //  P1 Report Form 
  await sql`
    CREATE TABLE IF NOT EXISTS report_form (
      id serial PRIMARY KEY,
      patient_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now(),
      
      -- Demographics
      date_of_birth date,
      age integer,
      gender text,
      height numeric,
      weight numeric,
      bmi numeric,
      ethnicity text,
      
      -- Lifestyle
      smoking text,
      smoking_duration numeric,
      cigarettes_per_day integer,
      alcohol text,
      diet text,
      diet_other_text text,
      
      -- Family History
      heart_attack text,
      sudden_death text,
      stroke text,
      heart_failure text,
      heart_rhythm text,
      heart_defect text,
      blood_pressure text,
      diabetes text,
      cholesterol text,
      cancer text,
      other_illness_text text,
      nyha text,
      acc_stage text,
      
      -- Medical History
      diabetes_type_1 text,
      diabetes_type_2 text,
      metabolic_syndrome text,
      dyslipidemia text,
      thyroid_dysfunction text,
      on_dialysis text,
      coagulation_liver_disease text,
      anemia text,
      chronic_liver_disease text,
      chronic_bronchial text,
      pulmonary_hypertension text,
      sleep_apnea text,
      primary_tumor text,
      autoimmune text,
      depression_anxiety text,
      preeclampsia text,
      hellp text,
      
      -- Procedures
      pci text,
      cabg text,
      svr text,
      tavi text,
      septal_myectomy_2 text,
      myectomy_year text,
      cardiac_pacemaker text,
      cardiac_pacemaker_year text,
      cardiac_icd text,
      cardiac_icd_year text,
      cardiac_crt text,
      cardiac_crt_year text,
      cardiac_catheter_ablation text,
      cardiac_catheter_ablation_year text,
      cardiac_maze_procedure text,
      cardiac_maze_procedure_year text,
      lvad_implementation text,
      lvad_implementation_year text,
      heart_transplant text,
      heart_transplant_year text,
      pulmonary_thromboendarterectomy text,
      pulmonary_thromboendarterectomy_year text,
      aortic_aneurysm text,
      aortic_aneurysm_year text,
      thoracic_surgery text,
      thoracic_surgery_year text,
      abdominal_surgeries text,
      abdominal_surgeries_year text,
      
      -- Medications
      ace_inhibitors text,
      ace_inhibitors_drugs text,
      arbs_2 text,
      arb_drugs text,
      beta_blockers text,
      beta_blockers_drugs text,
      calcium_channel_blockers text,
      calcium_channel_blockers_drugs text,
      diuretics_tablets text,
      diuretics_tablets_drugs text,
      other_heart_failure_medications text,
      other_heart_failure_medications_drugs text,
      nitrates text,
      nitrates_drugs text,
      antiarryhthmic_drugs text,
      antiarryhthmic_drugs_drugs text,
      antiplatelet_medication text,
      antiplatelet_medication_drugs text,
      oral_anticoagulants text,
      oral_anticoagulants_drugs text,
      statins text,
      statins_drugs text,
      other_lipid_lowering_drugs text,
      other_lipid_lowering_drugs_drugs text,
      medication_for_diabetes text,
      medication_for_diabetes_drugs text,
      medication_thyroid text,
      medication_thyroid_drugs text,
      medication_for_antidepressant text,
      medication_for_antidepressant_drugs text,
      anti_anxiety text,
      anti_anxiety_drugs text,
      other_medication text,
      
      -- Timing & Type Input
      timing_and_type_input text,
      failure_phenotype text,
      
      -- Clinical Assessment
      clinical_ischemia text,
      prior_myocardial text,
      coronary_artery_disease text,
      hypotension text,
      pleural_effusion text,
      jugular_venous_distension text,
      
      -- Hemodynamics
      cardiac_index numeric,
      cardiac_index_not_measured text,
      systemic_vascular_resistance numeric,
      systemic_vascular_resistance_not_measured text,
      right_atrial_pressure numeric,
      right_atrial_pressure_not_measured text,
      right_ventricular_pressure numeric,
      right_ventricular_pressure_not_measured text,
      pulmonary_artery_pressure numeric,
      pulmonary_artery_pressure_not_measured text,
      pulmonary_capillary_wedge_pressure numeric,
      pulmonary_capillary_wedge_pressure_not_measured text,
      aortic_pressure_during_cath numeric,
      aortic_pressure_during_cath_not_measured text,
      pulmonary_vascular_resistance numeric,
      pulmonary_vascular_resistance_not_measured text,
      pulmonary_hypertension_catheter text,
      
      -- Biomarkers
      troponin_i numeric,
      troponin_t numeric,
      nt_probnp numeric,
      bnp numeric,
      bnp_not_measured text,
      ck_mb numeric,
      ck_mb_not_measured text,
      myoglobin numeric,
      myoglobin_not_measured text,
      ldh numeric,
      ldh_not_measured text,
      crp numeric,
      ddimer numeric,
      homocysteine numeric,
      ldl numeric,
      hdl numeric,
      triglycerides numeric,
      hba1c numeric,
      bun numeric,
      creatinine numeric,
      blood_ph numeric,
      ketones text,
      sodium numeric,
      potassium numeric,
      calcium numeric,
      calcium_not_assessed text,
      magnesium numeric,
      magnesium_not_assessed text,
      chloride numeric,
      chloride_not_assessed text,
      tsh text,
      tsh_not_assessed text,
      free_t3 text,
      free_t3_not_assessed text,
      free_t4 text,
      free_t4_not_assessed text,
      testosterone numeric,
      testosterone_not_assessed text,
      ferritin numeric,
      transferrin_saturation numeric,
      coronary_artery_calcium text,
      periphral_artery text,
      right_ankle_brachial numeric,
      right_ankle_brachial_not_assessed text,
      left_ankle_brachial numeric,
      left_ankle_brachial_not_assessed text,
      
      -- Disease Categories
      aa_ad text,
      chd text,
      endocarditis1 text,
      myocarditis1 text,
      pericarditis1 text,
      disease_present text,
      disease_present_result text,
      disease_present2 text,
      disease_present2_result text,
      disease_present3 text,
      disease_present3_result text,
      disease_present4 text,
      disease_present4_result text,
      
      -- Auscultation
      asymptomatic_valvular text,
      murmur_present text,
      s3 text,
      s4 text,
      
      -- Cardiac Assessment - Structure & Function
      lv_size text,
      lvedv numeric,
      lvedv_not_assessed text,
      lvesv numeric,
      lvesv_not_assessed text,
      lvef numeric,
      lvef_not_assessed text,
      fs numeric,
      fs_not_assessed text,
      lv_mass numeric,
      lv_mass_not_assessed text,
      lv_mass_index numeric,
      lv_mass_index_not_assessed text,
      gls numeric,
      gls_not_assessed text,
      cd_on_imaging text,
      lv_hypertrophy text,
      e_e_prime_ratio numeric,
      ejection_time numeric,
      ejection_time_not_assessed text,
      cardiac_output numeric,
      cardiac_output_not_assessed text,
      rv_size text,
      rv_diameter numeric,
      rv_diameter_not_assessed text,
      rv_wall_thickness numeric,
      rv_wall_thickness_not_assessed text,
      rv_ejection_fraction numeric,
      rv_ejection_fraction_not_assessed text,
      rv_tapse numeric,
      rv_tapse_not_assessed text,
      left_atrial_volume numeric,
      left_atrial_volume_not_assessed text,
      aortic_root_diameter numeric,
      aortic_root_diameter_not_assessed text,
      ascending_aorta_diameter numeric,
      ascending_aorta_diameter_not_assessed text,
      
      -- Cardiac Assessment - Chambers & Flow
      ivc_diameter numeric,
      ivc_diameter_not_assessed text,
      ivc_collapsibility_index numeric,
      ivc_collapsibility_index_not_assessed text,
      wall_motion_abnormalities text,
      valvular_function text,
      valve_area numeric,
      pressure_peak numeric,
      pressure_mean numeric,
      pressure_gradients_not_assessed text,
      regurgitation_volume numeric,
      regurgitation_volume_not_assessed text,
      regurgitation_fraction numeric,
      regurgitation_fraction_not_assessed text,
      valvular_disease_severity text,
      
      -- Summary
      summary text,
      summary1 text
    );
  `;

  // Diagnostic Results from AI Analysis
  await sql`
    CREATE TABLE IF NOT EXISTS diagnostic_results (
      id serial PRIMARY KEY,
      patient_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now(),
      
      -- Report Metadata
      generated_at timestamptz,
      report_version text DEFAULT '1.7',
      analysis_model text DEFAULT 'Gemini 2.0',
      
      -- Risk Assessment
      risk_level text,
      risk_percentage integer,
      risk_factors jsonb,
      
      -- Key Clinical Findings
      key_findings jsonb,
      cardiac_recommendations jsonb,
      lifestyle_modifications jsonb,
      
      -- Clinical Plan
      monitoring_plan text,
      follow_up_timeline text,
      urgent_concerns jsonb,
      confidence_level integer,
      
      -- Condition-Specific Risk Assessments (Cardiac Monitoring)
      condition_risk_assessments jsonb,
      
      -- Comprehensive Clinical Assessment & Recommendations
      clinical_assessment text,
      detailed_recommendations text,
      
      -- Summary
      summary text,
      diagnostic_summary text,
      prognosis_note text,
      
      -- Data Sources
      has_feedback_data boolean,
      has_report_data boolean,
      has_ecg_data boolean,
      
      -- Raw Data References
      ecg_findings jsonb,
      vitals jsonb,
      labs jsonb,
      demographics jsonb,
      symptoms jsonb,
      
      -- Cloudflare Storage
      cloudflare_html_url text,
      cloudflare_json_url text,
      
      -- GRACE-3 Risk Scoring (https://www.grace-3.com/)
      grace3_score numeric,
      grace3_mortality_6month numeric,
      grace3_major_adverse_event_6month numeric,
      grace3_one_year_mortality numeric,
      grace3_one_year_major_adverse_event numeric,
      grace3_risk_category text,
      grace3_parameters jsonb,
      grace3_components jsonb,
      grace3_calculated_at timestamptz
    );
  `;

  // Migration: older deployments created diagnostic_results before these existed.
  await sql`ALTER TABLE diagnostic_results ADD COLUMN IF NOT EXISTS has_document_data boolean;`;
  await sql`ALTER TABLE diagnostic_results ADD COLUMN IF NOT EXISTS document_findings jsonb;`;

  //  Patient Documents (uploaded files + AI-extracted structured data)
  await sql`
    CREATE TABLE IF NOT EXISTS patient_documents (
      id serial PRIMARY KEY,
      patient_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      uploaded_by integer NOT NULL REFERENCES users(id),
      original_filename text,
      content_type text,
      file_size_bytes integer,
      r2_original_key text NOT NULL,
      r2_json_key text,
      extraction_status text NOT NULL DEFAULT 'pending'
        CHECK (extraction_status IN ('pending', 'processing', 'done', 'failed')),
      extraction_error text,
      document_type text,
      extracted_json json,
      extraction_model text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_patient_documents_patient ON patient_documents(patient_id);`;

  // Migration: jsonb reorders object keys on storage (Postgres does not preserve
  // insertion order for jsonb), which silently scrambled the document-order display
  // requirement — json stores the exact input text, key order included, so switch
  // any pre-existing jsonb column over.
  await sql`ALTER TABLE patient_documents ALTER COLUMN extracted_json TYPE json USING extracted_json::text::json;`;
}

// Users


export async function findUserByUsername(username) {
  const { rows } = await sql`SELECT * FROM users WHERE username = ${username} LIMIT 1`;
  return rows[0] || null;
}

export async function createUser({ fullName, username, password, role }) {
  const passwordHash = await bcrypt.hash(password, 10);
  const { rows } = await sql`
    INSERT INTO users (full_name, username, password_hash, role)
    VALUES (${fullName}, ${username}, ${passwordHash}, ${role})
    RETURNING id, full_name, username, role, created_at
  `;
  return rows[0];
}

export async function validateUserPassword(user, password) {
  return bcrypt.compare(password, user.password_hash);
}


// Safe parsing helper for numeric values
function safeParseInt(val) {
  if (!val || val === '') return null;
  const num = parseInt(val, 10);
  return Number.isNaN(num) ? null : num;
}

function safeParseFloat(val) {
  if (!val || val === '') return null;
  const num = parseFloat(val);
  return Number.isNaN(num) ? null : num;
}

export async function insertFeedbackForm(patientId, form) {
  const { rows } = await sql`
    INSERT INTO feedback_form (
      patient_id, source,
      dyspnea, orthopnea, paroxysmal_nocturnal_dyspnea, cyanosis,
      jugular_venous_distension, nighttime_urination_count,
      chest_pain, arm_pain, leg_pain, jaw_pain, back_pain,
      stomach_pain, headache, numb_arms_legs, visual_disturbances,
      palpitations, sweating, leg_swelling, abdominal_bloating,
      weight_kg, walk_6min_distance_m,
      blood_pressure_systolic, blood_pressure_diastolic,
      fatigue_level, sleep_quality,
      anxious, erectile_dysfunction, free_comment
    ) VALUES (
      ${patientId}, 'manual',
      ${form.dyspnea || null}, ${form.orthopnea || null},
      ${form.paroxysmal_nocturnal_dyspnea || null}, ${form.cyanosis || null},
      ${form.jugular_venous_distension || null},
      ${safeParseInt(form.nighttime_urination_count)},
      ${form.chest_pain || null}, ${form.arm_pain || null},
      ${form.leg_pain || null}, ${form.jaw_pain || null},
      ${form.back_pain || null}, ${form.stomach_pain || null},
      ${form.headache || null}, ${form.numb_arms_legs || null},
      ${form.visual_disturbances || null}, ${form.palpitations || null},
      ${form.sweating || null}, ${form.leg_swelling || null},
      ${form.abdominal_bloating || null},
      ${safeParseFloat(form.weight_kg)},
      ${safeParseFloat(form.walk_6min_distance_m)},
      ${safeParseInt(form.blood_pressure_systolic)},
      ${safeParseInt(form.blood_pressure_diastolic)},
      ${safeParseInt(form.fatigue_level)},
      ${safeParseInt(form.sleep_quality)},
      ${form.anxious || null}, ${form.erectile_dysfunction || null},
      ${form.free_comment || null}
    )
    ON CONFLICT (patient_id, feedback_date) DO UPDATE SET
      dyspnea = EXCLUDED.dyspnea,
      orthopnea = EXCLUDED.orthopnea,
      paroxysmal_nocturnal_dyspnea = EXCLUDED.paroxysmal_nocturnal_dyspnea,
      cyanosis = EXCLUDED.cyanosis,
      jugular_venous_distension = EXCLUDED.jugular_venous_distension,
      nighttime_urination_count = EXCLUDED.nighttime_urination_count,
      chest_pain = EXCLUDED.chest_pain,
      arm_pain = EXCLUDED.arm_pain,
      leg_pain = EXCLUDED.leg_pain,
      jaw_pain = EXCLUDED.jaw_pain,
      back_pain = EXCLUDED.back_pain,
      stomach_pain = EXCLUDED.stomach_pain,
      headache = EXCLUDED.headache,
      numb_arms_legs = EXCLUDED.numb_arms_legs,
      visual_disturbances = EXCLUDED.visual_disturbances,
      palpitations = EXCLUDED.palpitations,
      sweating = EXCLUDED.sweating,
      leg_swelling = EXCLUDED.leg_swelling,
      abdominal_bloating = EXCLUDED.abdominal_bloating,
      weight_kg = EXCLUDED.weight_kg,
      walk_6min_distance_m = EXCLUDED.walk_6min_distance_m,
      blood_pressure_systolic = EXCLUDED.blood_pressure_systolic,
      blood_pressure_diastolic = EXCLUDED.blood_pressure_diastolic,
      fatigue_level = EXCLUDED.fatigue_level,
      sleep_quality = EXCLUDED.sleep_quality,
      anxious = EXCLUDED.anxious,
      erectile_dysfunction = EXCLUDED.erectile_dysfunction,
      free_comment = EXCLUDED.free_comment,
      source = 'manual'
    RETURNING *
  `;
  return rows[0];
}

export async function getFeedbackFormByPatient(patientId) {
  const { rows } = await sql`
    SELECT * FROM feedback_form WHERE patient_id = ${patientId} ORDER BY created_at DESC
  `;
  return rows;
}


export async function hasFeedbackToday(patientId) {
  const { rows } = await sql`
    SELECT id FROM feedback_form
    WHERE patient_id = ${patientId}
    AND feedback_date = CURRENT_DATE
    LIMIT 1
  `;
  return rows.length > 0;
}


export const QUESTION_ID_MAP = {
  q1_dyspnea:                      'dyspnea',
  q2_orthopnea:                    'orthopnea',
  q3_paroxysmal_nocturnal_dyspnea: 'paroxysmal_nocturnal_dyspnea',
  q4_cyanosis:                     'cyanosis',
  q5_jugular_venous_distension:    'jugular_venous_distension',
  q6_nighttime_urination:          'nighttime_urination_count',
  q7_chest_pain:                   'chest_pain',
  q8_arm_pain:                     'arm_pain',
  q9_leg_pain:                     'leg_pain',
  q10_jaw_pain:                    'jaw_pain',
  q11_back_pain:                   'back_pain',
  q12_stomach_pain:                'stomach_pain',
  q13_headache:                    'headache',
  q14_numb_arms_legs:              'numb_arms_legs',
  q15_visual_disturbances:         'visual_disturbances',
  q16_palpitations:                'palpitations',
  q17_sweating:                    'sweating',
  q18_leg_swelling:                'leg_swelling',
  q19_abdominal_bloating:          'abdominal_bloating',
  q20_weight:                      'weight_kg',
  q21_walk_6min:                   'walk_6min_distance_m',
  // Q22 blood pressure — n8n sends TWO separate tool calls
  q22_blood_pressure_systolic:     'blood_pressure_systolic',
  q22_blood_pressure_diastolic:    'blood_pressure_diastolic',
  q23_fatigue:                     'fatigue_level',
  q24_sleep_quality:               'sleep_quality',
  q25_anxious:                     'anxious',
  q26_erectile_dysfunction:        'erectile_dysfunction',
  q27_comments:                    'free_comment',
};

// Column type map — tells updateFeedbackAnswer how to cast each value
const COLUMN_TYPE = {
  nighttime_urination_count: 'integer',
  blood_pressure_systolic:   'integer',
  blood_pressure_diastolic:  'integer',
  fatigue_level:             'integer',
  sleep_quality:             'integer',
  weight_kg:                 'numeric',
  walk_6min_distance_m:      'numeric',
};

// Cast a string value coming from n8n to the correct JS type for Postgres
function castValue(columnName, value) {
  const type = COLUMN_TYPE[columnName];
  if (value === null || value === undefined || value === '') return null;
  if (type === 'integer') {
    const n = parseInt(value, 10);
    return isNaN(n) ? null : n;
  }
  if (type === 'numeric') {
    const n = parseFloat(value);
    return isNaN(n) ? null : n;
  }
  return String(value); // TEXT columns — keep as string
}


// Ensure today's feedback_form row exists for this patient, without touching any
// column values — used before any incremental (per-question or per-follow-up) write
// so existing answers already on today's row are never disturbed.
async function ensureTodayFeedbackRow(patientId) {
  const { rows: existing } = await sql`
    SELECT id FROM feedback_form
    WHERE patient_id = ${patientId}
    AND feedback_date = CURRENT_DATE
    LIMIT 1
  `;

  if (existing.length > 0) {
    return existing[0].id;
  }

  // Insert a fresh row for today — source MUST be set to satisfy CHECK constraint
  const { rows: inserted } = await sql`
    INSERT INTO feedback_form (patient_id, source, feedback_date)
    VALUES (${patientId}, 'voice', CURRENT_DATE)
    ON CONFLICT (patient_id, feedback_date) DO NOTHING
    RETURNING id
  `;

  if (inserted.length > 0) {
    return inserted[0].id;
  }

  // Race condition: another request created the row between our SELECT and INSERT
  const { rows: retry } = await sql`
    SELECT id FROM feedback_form
    WHERE patient_id = ${patientId}
    AND feedback_date = CURRENT_DATE
    LIMIT 1
  `;
  return retry[0].id;
}

export async function updateFeedbackAnswer(patientId, questionId, answer, sessionId) {
  if (!QUESTION_ID_MAP[questionId]) {
    throw new Error(
      `Invalid question_id: "${questionId}". Valid IDs: ${Object.keys(QUESTION_ID_MAP).join(', ')}`
    );
  }

  const columnName = QUESTION_ID_MAP[questionId];
  const castedValue = castValue(columnName, answer);

  // Ensure today's row exists, then update ONLY the answered column — every other
  // column (answered on a previous call, or not yet answered) is left untouched.
  const feedbackId = await ensureTodayFeedbackRow(patientId);

  await sql.query(
    `UPDATE feedback_form SET ${columnName} = $1 WHERE id = $2`,
    [castedValue, feedbackId]
  );

  console.log(
    `[DB] patient:${patientId} session:${sessionId} q:${questionId} → ${columnName} = ${castedValue} (row ${feedbackId})`
  );

  return {
    feedback_id: feedbackId,
    question_id: questionId,
    column: columnName,
    answer: castedValue,
    saved: true,
  };
}

// Append a follow-up answer to the specific question's own `<column>_free_text`
// companion column — not a shared blob — so it stays right next to the structured
// answer it clarifies. Appending (rather than overwriting) preserves multiple notes
// if more than one follow-up ever lands on the same question across a session.
export async function saveFollowupAnswer(patientId, questionId, contextLabel, answerText, sessionId) {
  if (!QUESTION_ID_MAP[questionId]) {
    throw new Error(
      `Invalid question_id: "${questionId}". Valid IDs: ${Object.keys(QUESTION_ID_MAP).join(', ')}`
    );
  }

  const baseColumn = QUESTION_ID_MAP[questionId];
  const freeTextColumn = `${baseColumn}_free_text`;
  const feedbackId = await ensureTodayFeedbackRow(patientId);
  const note = contextLabel ? `${contextLabel}: ${answerText}` : String(answerText);

  const { rows } = await sql.query(
    `UPDATE feedback_form
     SET ${freeTextColumn} = CASE
       WHEN ${freeTextColumn} IS NULL OR ${freeTextColumn} = '' THEN $1
       ELSE ${freeTextColumn} || E'\n' || $1
     END
     WHERE id = $2
     RETURNING ${freeTextColumn} AS free_text`,
    [note, feedbackId]
  );

  console.log(
    `[DB] patient:${patientId} session:${sessionId} q:${questionId} → ${freeTextColumn} += "${note}" (row ${feedbackId})`
  );

  return {
    feedback_id: feedbackId,
    question_id: questionId,
    column: freeTextColumn,
    free_text: rows[0]?.free_text,
    saved: true,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// P1 Report Form
// ─────────────────────────────────────────────────────────────────────────────

export async function insertP1ReportForm(patientId, form) {
  try {
    const { rows } = await sql`
      INSERT INTO report_form (
        patient_id, date_of_birth, age, gender, height, weight, bmi, ethnicity, smoking, smoking_duration,
        cigarettes_per_day, alcohol, diet, diet_other_text, heart_attack, sudden_death, stroke, heart_failure,
        heart_rhythm, heart_defect, blood_pressure, diabetes, cholesterol, cancer, other_illness_text, nyha,
        acc_stage, diabetes_type_1, diabetes_type_2, metabolic_syndrome, dyslipidemia, thyroid_dysfunction,
        on_dialysis, coagulation_liver_disease, anemia, chronic_liver_disease, chronic_bronchial,
        pulmonary_hypertension, sleep_apnea, primary_tumor, autoimmune, depression_anxiety, preeclampsia, hellp,
        pci, cabg, svr, tavi, septal_myectomy_2, myectomy_year, cardiac_pacemaker, cardiac_pacemaker_year,
        cardiac_icd, cardiac_icd_year, cardiac_crt, cardiac_crt_year, cardiac_catheter_ablation,
        cardiac_catheter_ablation_year, cardiac_maze_procedure, cardiac_maze_procedure_year, lvad_implementation,
        lvad_implementation_year, heart_transplant, heart_transplant_year, pulmonary_thromboendarterectomy,
        pulmonary_thromboendarterectomy_year, aortic_aneurysm, aortic_aneurysm_year, thoracic_surgery,
        thoracic_surgery_year, abdominal_surgeries, abdominal_surgeries_year, ace_inhibitors,
        ace_inhibitors_drugs, arbs_2, arb_drugs, beta_blockers, beta_blockers_drugs, calcium_channel_blockers,
        calcium_channel_blockers_drugs, diuretics_tablets, diuretics_tablets_drugs, other_heart_failure_medications,
        other_heart_failure_medications_drugs, nitrates, nitrates_drugs, antiarryhthmic_drugs,
        antiarryhthmic_drugs_drugs, antiplatelet_medication, antiplatelet_medication_drugs, oral_anticoagulants,
        oral_anticoagulants_drugs, statins, statins_drugs, other_lipid_lowering_drugs,
        other_lipid_lowering_drugs_drugs, medication_for_diabetes, medication_for_diabetes_drugs, medication_thyroid,
        medication_thyroid_drugs, medication_for_antidepressant, medication_for_antidepressant_drugs, anti_anxiety,
        anti_anxiety_drugs, other_medication, 
        
        timing_and_type_input, failure_phenotype, clinical_ischemia,
        prior_myocardial, coronary_artery_disease, hypotension, pleural_effusion, jugular_venous_distension,
        cardiac_index, cardiac_index_not_measured, systemic_vascular_resistance, systemic_vascular_resistance_not_measured,
        right_atrial_pressure, right_atrial_pressure_not_measured, right_ventricular_pressure,
        right_ventricular_pressure_not_measured, pulmonary_artery_pressure, pulmonary_artery_pressure_not_measured,
        pulmonary_capillary_wedge_pressure, pulmonary_capillary_wedge_pressure_not_measured,
        aortic_pressure_during_cath, aortic_pressure_during_cath_not_measured, pulmonary_vascular_resistance,
        pulmonary_vascular_resistance_not_measured, pulmonary_hypertension_catheter, troponin_i, troponin_t,
        nt_probnp, bnp, bnp_not_measured, ck_mb, ck_mb_not_measured, myoglobin, myoglobin_not_measured, ldh,
        ldh_not_measured, crp, ddimer, homocysteine, ldl, hdl, triglycerides, hba1c, bun, creatinine, blood_ph,
        ketones, sodium, potassium, calcium, calcium_not_assessed, magnesium, magnesium_not_assessed, chloride,
        chloride_not_assessed, tsh, tsh_not_assessed, free_t3, free_t3_not_assessed, free_t4, free_t4_not_assessed,
        testosterone, testosterone_not_assessed, ferritin, transferrin_saturation, coronary_artery_calcium,
        periphral_artery, right_ankle_brachial, right_ankle_brachial_not_assessed, left_ankle_brachial,
        left_ankle_brachial_not_assessed, aa_ad, chd, endocarditis1, myocarditis1, pericarditis1, disease_present,
        disease_present_result, disease_present2, disease_present2_result, disease_present3, disease_present3_result,
        disease_present4, disease_present4_result, asymptomatic_valvular, murmur_present, s3, s4, lv_size, lvedv,
        lvedv_not_assessed, lvesv, lvesv_not_assessed, lvef, lvef_not_assessed, fs, fs_not_assessed, lv_mass,
        lv_mass_not_assessed, lv_mass_index, lv_mass_index_not_assessed, gls, gls_not_assessed, cd_on_imaging,
        lv_hypertrophy, e_e_prime_ratio, ejection_time, ejection_time_not_assessed, cardiac_output,
        cardiac_output_not_assessed, rv_size, rv_diameter, rv_diameter_not_assessed, rv_wall_thickness,
        rv_wall_thickness_not_assessed, rv_ejection_fraction, rv_ejection_fraction_not_assessed, rv_tapse,
        rv_tapse_not_assessed, left_atrial_volume, left_atrial_volume_not_assessed, aortic_root_diameter,
        aortic_root_diameter_not_assessed, ascending_aorta_diameter, ascending_aorta_diameter_not_assessed,
        ivc_diameter, ivc_diameter_not_assessed, ivc_collapsibility_index, ivc_collapsibility_index_not_assessed,
        wall_motion_abnormalities, valvular_function, valve_area, pressure_peak, pressure_mean,
        pressure_gradients_not_assessed, regurgitation_volume, regurgitation_volume_not_assessed,
        regurgitation_fraction, regurgitation_fraction_not_assessed, valvular_disease_severity, summary
      ) VALUES (
        ${patientId}, ${form.date_of_birth || null}, ${form.age || null}, ${form.gender || null},
        ${form.height || null}, ${form.weight || null}, ${form.bmi || null}, ${form.ethnicity || null},
        ${form.smoking || null}, ${form.smoking_duration || null}, ${form.cigarettes_per_day || null},
        ${form.alcohol || null}, ${form.diet || null}, ${form.diet_other_text || null},
        ${form.heart_attack || null}, ${form.sudden_death || null}, ${form.stroke || null},
        ${form.heart_failure || null}, ${form.heart_rhythm || null}, ${form.heart_defect || null},
        ${form.blood_pressure || null}, ${form.diabetes || null}, ${form.cholesterol || null},
        ${form.cancer || null}, ${form.other_illness_text || null}, ${form.nyha || null},
        ${form.acc_stage || null}, ${form.diabetes_type_1 || null}, ${form.diabetes_type_2 || null},
        ${form.metabolic_syndrome || null}, ${form.dyslipidemia || null}, ${form.thyroid_dysfunction || null},
        ${form.on_dialysis || null}, ${form.coagulation_liver_disease || null}, ${form.anemia || null},
        ${form.chronic_liver_disease || null}, ${form.chronic_bronchial || null},
        ${form.pulmonary_hypertension || null}, ${form.sleep_apnea || null}, ${form.primary_tumor || null},
        ${form.autoimmune || null}, ${form.depression_anxiety || null}, ${form.preeclampsia || null},
        ${form.hellp || null}, ${form.pci || null}, ${form.cabg || null}, ${form.svr || null},
        ${form.tavi || null}, ${form.septal_myectomy_2 || null}, ${form.myectomy_year || null},
        ${form.cardiac_pacemaker || null}, ${form.cardiac_pacemaker_year || null}, ${form.cardiac_icd || null},
        ${form.cardiac_icd_year || null}, ${form.cardiac_crt || null}, ${form.cardiac_crt_year || null},
        ${form.cardiac_catheter_ablation || null}, ${form.cardiac_catheter_ablation_year || null},
        ${form.cardiac_maze_procedure || null}, ${form.cardiac_maze_procedure_year || null},
        ${form.lvad_implementation || null}, ${form.lvad_implementation_year || null},
        ${form.heart_transplant || null}, ${form.heart_transplant_year || null},
        ${form.pulmonary_thromboendarterectomy || null}, ${form.pulmonary_thromboendarterectomy_year || null},
        ${form.aortic_aneurysm || null}, ${form.aortic_aneurysm_year || null}, ${form.thoracic_surgery || null},
        ${form.thoracic_surgery_year || null}, ${form.abdominal_surgeries || null},
        ${form.abdominal_surgeries_year || null}, ${form.ace_inhibitors || null},
        ${form.ace_inhibitors_drugs || null}, ${form.arbs_2 || null}, ${form.arb_drugs || null},
        ${form.beta_blockers || null}, ${form.beta_blockers_drugs || null}, ${form.calcium_channel_blockers || null},
        ${form.calcium_channel_blockers_drugs || null}, ${form.diuretics_tablets || null},
        ${form.diuretics_tablets_drugs || null}, ${form.other_heart_failure_medications || null},
        ${form.other_heart_failure_medications_drugs || null}, ${form.nitrates || null},
        ${form.nitrates_drugs || null}, ${form.antiarryhthmic_drugs || null},
        ${form.antiarryhthmic_drugs_drugs || null}, ${form.antiplatelet_medication || null},
        ${form.antiplatelet_medication_drugs || null}, ${form.oral_anticoagulants || null},
        ${form.oral_anticoagulants_drugs || null}, ${form.statins || null}, ${form.statins_drugs || null},
        ${form.other_lipid_lowering_drugs || null}, ${form.other_lipid_lowering_drugs_drugs || null},
        ${form.medication_for_diabetes || null}, ${form.medication_for_diabetes_drugs || null},
        ${form.medication_thyroid || null}, ${form.medication_thyroid_drugs || null},
        ${form.medication_for_antidepressant || null}, ${form.medication_for_antidepressant_drugs || null},
        ${form.anti_anxiety || null}, ${form.anti_anxiety_drugs || null}, ${form.other_medication || null},

        ${form.timing_and_type_input || null}, ${form.failure_phenotype || null},
        ${form.clinical_ischemia || null}, ${form.prior_myocardial || null},
        ${form.coronary_artery_disease || null}, ${form.hypotension || null}, ${form.pleural_effusion || null},
        ${form.jugular_venous_distension || null}, ${form.cardiac_index || null},
        ${form.cardiac_index_not_measured || null}, ${form.systemic_vascular_resistance || null},
        ${form.systemic_vascular_resistance_not_measured || null}, ${form.right_atrial_pressure || null},
        ${form.right_atrial_pressure_not_measured || null}, ${form.right_ventricular_pressure || null},
        ${form.right_ventricular_pressure_not_measured || null}, ${form.pulmonary_artery_pressure || null},
        ${form.pulmonary_artery_pressure_not_measured || null}, ${form.pulmonary_capillary_wedge_pressure || null},
        ${form.pulmonary_capillary_wedge_pressure_not_measured || null}, ${form.aortic_pressure_during_cath || null},
        ${form.aortic_pressure_during_cath_not_measured || null}, ${form.pulmonary_vascular_resistance || null},
        ${form.pulmonary_vascular_resistance_not_measured || null}, ${form.pulmonary_hypertension_catheter || null},
        ${form.troponin_i || null}, ${form.troponin_t || null}, ${form.nt_probnp || null}, ${form.bnp || null},
        ${form.bnp_not_measured || null}, ${form.ck_mb || null}, ${form.ck_mb_not_measured || null},
        ${form.myoglobin || null}, ${form.myoglobin_not_measured || null}, ${form.ldh || null},
        ${form.ldh_not_measured || null}, ${form.crp || null}, ${form.ddimer || null},
        ${form.homocysteine || null}, ${form.ldl || null}, ${form.hdl || null}, ${form.triglycerides || null},
        ${form.hba1c || null}, ${form.bun || null}, ${form.creatinine || null}, ${form.blood_ph || null},
        ${form.ketones || null}, ${form.sodium || null}, ${form.potassium || null}, ${form.calcium || null},
        ${form.calcium_not_assessed || null}, ${form.magnesium || null}, ${form.magnesium_not_assessed || null},
        ${form.chloride || null}, ${form.chloride_not_assessed || null}, ${form.tsh || null},
        ${form.tsh_not_assessed || null}, ${form.free_t3 || null}, ${form.free_t3_not_assessed || null},
        ${form.free_t4 || null}, ${form.free_t4_not_assessed || null}, ${form.testosterone || null},
        ${form.testosterone_not_assessed || null}, ${form.ferritin || null},
        ${form.transferrin_saturation || null}, ${form.coronary_artery_calcium || null},
        ${form.periphral_artery || null}, ${form.right_ankle_brachial || null},
        ${form.right_ankle_brachial_not_assessed || null}, ${form.left_ankle_brachial || null},
        ${form.left_ankle_brachial_not_assessed || null}, ${form.aa_ad || null}, ${form.chd || null},
        ${form.endocarditis1 || null}, ${form.myocarditis1 || null}, ${form.pericarditis1 || null},
        ${form.disease_present || null}, ${form.disease_present_result || null}, ${form.disease_present2 || null},
        ${form.disease_present2_result || null}, ${form.disease_present3 || null},
        ${form.disease_present3_result || null}, ${form.disease_present4 || null},
        ${form.disease_present4_result || null}, ${form.asymptomatic_valvular || null},
        ${form.murmur_present || null}, ${form.s3 || null}, ${form.s4 || null}, ${form.lv_size || null},
        ${form.lvedv || null}, ${form.lvedv_not_assessed || null}, ${form.lvesv || null},
        ${form.lvesv_not_assessed || null}, ${form.lvef || null}, ${form.lvef_not_assessed || null},
        ${form.fs || null}, ${form.fs_not_assessed || null}, ${form.lv_mass || null},
        ${form.lv_mass_not_assessed || null}, ${form.lv_mass_index || null},
        ${form.lv_mass_index_not_assessed || null}, ${form.gls || null}, ${form.gls_not_assessed || null},
        ${form.cd_on_imaging || null}, ${form.lv_hypertrophy || null}, ${form.e_e_prime_ratio || null},
        ${form.ejection_time || null}, ${form.ejection_time_not_assessed || null}, ${form.cardiac_output || null},
        ${form.cardiac_output_not_assessed || null}, ${form.rv_size || null}, ${form.rv_diameter || null},
        ${form.rv_diameter_not_assessed || null}, ${form.rv_wall_thickness || null},
        ${form.rv_wall_thickness_not_assessed || null}, ${form.rv_ejection_fraction || null},
        ${form.rv_ejection_fraction_not_assessed || null}, ${form.rv_tapse || null},
        ${form.rv_tapse_not_assessed || null}, ${form.left_atrial_volume || null},
        ${form.left_atrial_volume_not_assessed || null}, ${form.aortic_root_diameter || null},
        ${form.aortic_root_diameter_not_assessed || null}, ${form.ascending_aorta_diameter || null},
        ${form.ascending_aorta_diameter_not_assessed || null}, ${form.ivc_diameter || null},
        ${form.ivc_diameter_not_assessed || null}, ${form.ivc_collapsibility_index || null},
        ${form.ivc_collapsibility_index_not_assessed || null}, ${form.wall_motion_abnormalities || null},
        ${form.valvular_function || null}, ${form.valve_area || null}, ${form.pressure_peak || null},
        ${form.pressure_mean || null}, ${form.pressure_gradients_not_assessed || null},
        ${form.regurgitation_volume || null}, ${form.regurgitation_volume_not_assessed || null},
        ${form.regurgitation_fraction || null}, ${form.regurgitation_fraction_not_assessed || null},
        ${form.valvular_disease_severity || null}, ${form.summary || null}
      )
      RETURNING *
    `;
    console.log(`P1 report inserted with ID: ${rows[0].id}`);
    return rows[0];
  } catch (error) {
    console.error('Database error in insertP1ReportForm:', error);
    throw error;
  }
}

export async function getP1ReportFormByPatient(patientId) {
  const { rows } = await sql`
    SELECT * FROM report_form WHERE patient_id = ${patientId} ORDER BY created_at DESC
  `;
  return rows;
}


export async function insertDoctorReport({ patientId, doctorId, sickStatus, notes, diagnosis }) {
  const { rows } = await sql`
    INSERT INTO reports (patient_id, doctor_id, sick_status, notes, diagnosis)
    VALUES (${patientId}, ${doctorId}, ${sickStatus}, ${notes}, ${diagnosis})
    RETURNING *
  `;
  return rows[0];
}

export async function getPatientReports(patientId) {
  const { rows } = await sql`
    SELECT r.*, d.full_name AS doctor_name
    FROM reports r
    JOIN users d ON d.id = r.doctor_id
    WHERE r.patient_id = ${patientId}
    ORDER BY r.created_at DESC
  `;
  return rows;
}

// Patients List

export async function listPatients() {
  const { rows } = await sql`
    SELECT id, full_name, username
    FROM users
    WHERE role = 'patient'
    ORDER BY full_name ASC
  `;
  return rows;
}



// -----------------------------------

export async function upsertFeedbackAnswer(patientId, questionId, answerValue, sessionId) {
  if (!QUESTION_ID_MAP[questionId]) {
    throw new Error(
      `Invalid question_id: "${questionId}". Valid IDs: ${Object.keys(QUESTION_ID_MAP).join(', ')}`
    );
  }

  const columnName = QUESTION_ID_MAP[questionId];
  const castedValue = castValue(columnName, answerValue);

  // Step 1: Ensure today's row exists (source = 'voice' for n8n answers)
  const { rows: existing } = await sql`
    SELECT id FROM feedback_form
    WHERE patient_id = ${patientId}
    AND feedback_date = CURRENT_DATE
    LIMIT 1
  `;

  let feedbackId;

  if (existing.length > 0) {
    feedbackId = existing[0].id;
  } else {
    // Insert a fresh row for today — use ON CONFLICT with columns instead of constraint name
    const { rows: inserted } = await sql`
      INSERT INTO feedback_form (patient_id, source, feedback_date)
      VALUES (${patientId}, 'voice', CURRENT_DATE)
      ON CONFLICT (patient_id, feedback_date) DO NOTHING
      RETURNING id
    `;

    if (inserted.length > 0) {
      feedbackId = inserted[0].id;
    } else {
      // Race condition: another request created the row between our SELECT and INSERT
      const { rows: retry } = await sql`
        SELECT id FROM feedback_form
        WHERE patient_id = ${patientId}
        AND feedback_date = CURRENT_DATE
        LIMIT 1
      `;
      feedbackId = retry[0].id;
    }
  }

  // Step 2: Update the specific column — dynamic column name, safe because
  // columnName is validated against QUESTION_ID_MAP above
  await sql.query(
    `UPDATE feedback_form SET "${columnName}" = $1 WHERE id = $2`,
    [castedValue, feedbackId]
  );

  console.log(
    `[DB] patient:${patientId} session:${sessionId} q:${questionId} → ${columnName} = ${castedValue} (row ${feedbackId})`
  );

  return {
    feedback_id: feedbackId,
    question_id: questionId,
    column: columnName,
    answer: castedValue,
    saved: true,
  };
}

// Diagnostic Results (from n8n workflow + Gemini AI)

export async function saveDiagnosticResult(patientId, diagnosticData) {
  try {
    const { rows } = await sql`
      INSERT INTO diagnostic_results (
        patient_id, generated_at, report_version, analysis_model,
        risk_level, risk_percentage, condition_risk_assessments,
        clinical_assessment, detailed_recommendations,
        risk_factors, key_findings,
        cardiac_recommendations, lifestyle_modifications,
        monitoring_plan, follow_up_timeline, urgent_concerns, confidence_level,
        summary, diagnostic_summary, prognosis_note,
        has_feedback_data, has_report_data, has_ecg_data,
        ecg_findings, vitals, labs, demographics, symptoms,
        has_document_data, document_findings,
        gemini_result, claude_result, agreement_score,
        consensus_risk_level, consensus_risk_percentage, comparison_analysis,
        multi_ai_errors, multi_ai_available
      ) VALUES (
        ${patientId},
        ${diagnosticData.generated_at || new Date().toISOString()},
        ${diagnosticData.report_version || '1.7'},
        ${diagnosticData.analysis_model || 'Gemini 2.0'},
        ${diagnosticData.risk_level || null},
        ${diagnosticData.risk_percentage || null},
        ${diagnosticData.condition_risk_assessments ? JSON.stringify(diagnosticData.condition_risk_assessments) : null},
        ${diagnosticData.clinical_assessment || null},
        ${diagnosticData.detailed_recommendations || null},
        ${diagnosticData.risk_factors ? JSON.stringify(diagnosticData.risk_factors) : null},
        ${diagnosticData.key_findings ? JSON.stringify(diagnosticData.key_findings) : null},
        ${diagnosticData.cardiac_recommendations ? JSON.stringify(diagnosticData.cardiac_recommendations) : null},
        ${diagnosticData.lifestyle_modifications ? JSON.stringify(diagnosticData.lifestyle_modifications) : null},
        ${diagnosticData.monitoring_plan || null},
        ${diagnosticData.follow_up_timeline || null},
        ${diagnosticData.urgent_concerns ? JSON.stringify(diagnosticData.urgent_concerns) : null},
        ${diagnosticData.confidence_level || null},
        ${diagnosticData.summary || null},
        ${diagnosticData.diagnostic_summary || null},
        ${diagnosticData.prognosis_note || null},
        ${diagnosticData.data_sources?.feedback_form || false},
        ${diagnosticData.data_sources?.report_form || false},
        ${diagnosticData.data_sources?.ecg_analysis || false},
        ${diagnosticData.ecg_findings ? JSON.stringify(diagnosticData.ecg_findings) : null},
        ${diagnosticData.vitals ? JSON.stringify(diagnosticData.vitals) : null},
        ${diagnosticData.labs ? JSON.stringify(diagnosticData.labs) : null},
        ${diagnosticData.demographics ? JSON.stringify(diagnosticData.demographics) : null},
        ${diagnosticData.symptoms ? JSON.stringify(diagnosticData.symptoms) : null},
        ${diagnosticData.data_sources?.document_data || false},
        ${diagnosticData.document_findings ? JSON.stringify(diagnosticData.document_findings) : null},
        ${diagnosticData.gemini_result ? JSON.stringify(diagnosticData.gemini_result) : null},
        ${diagnosticData.claude_result ? JSON.stringify(diagnosticData.claude_result) : null},
        ${diagnosticData.agreement_score || null},
        ${diagnosticData.consensus_risk_level || null},
        ${diagnosticData.consensus_risk_percentage || null},
        ${diagnosticData.comparison_analysis || null},
        ${diagnosticData.multi_ai_errors ? JSON.stringify(diagnosticData.multi_ai_errors) : null},
        ${diagnosticData.multi_ai_available || false}
      )
      RETURNING *
    `;
    console.log(`Diagnostic result saved for patient ${patientId}`);
    return rows[0];
  } catch (error) {
    console.error('Error saving diagnostic result:', error);
    throw error;
  }
}

export async function getDiagnosticResultsByPatient(patientId) {
  try {
    const { rows } = await sql`
      SELECT * FROM diagnostic_results
      WHERE patient_id = ${patientId}
      ORDER BY created_at DESC
    `;
    return rows;
  } catch (error) {
    console.error('Error retrieving diagnostic results:', error);
    throw error;
  }
}

export async function getLatestDiagnosticResult(patientId) {
  try {
    const { rows } = await sql`
      SELECT * FROM diagnostic_results
      WHERE patient_id = ${patientId}
      ORDER BY created_at DESC
      LIMIT 1
    `;
    return rows[0] || null;
  } catch (error) {
    console.error('Error retrieving latest diagnostic result:', error);
    throw error;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Patient Documents (uploaded files + AI-extracted structured data)
// ─────────────────────────────────────────────────────────────────────────────

export async function insertPatientDocument(patientId, uploadedBy, {
  originalFilename, contentType, fileSizeBytes, r2OriginalKey,
}) {
  const { rows } = await sql`
    INSERT INTO patient_documents (
      patient_id, uploaded_by, original_filename, content_type,
      file_size_bytes, r2_original_key, extraction_status
    ) VALUES (
      ${patientId}, ${uploadedBy}, ${originalFilename || null}, ${contentType || null},
      ${fileSizeBytes || null}, ${r2OriginalKey}, 'processing'
    )
    RETURNING *
  `;
  return rows[0];
}

export async function markPatientDocumentDone(documentId, {
  r2JsonKey, documentType, extractedJson, extractionModel,
}) {
  const { rows } = await sql`
    UPDATE patient_documents
    SET extraction_status = 'done',
        r2_json_key = ${r2JsonKey || null},
        document_type = ${documentType || null},
        extracted_json = ${extractedJson ? JSON.stringify(extractedJson) : null},
        extraction_model = ${extractionModel || null},
        extraction_error = NULL
    WHERE id = ${documentId}
    RETURNING *
  `;
  return rows[0];
}

export async function markPatientDocumentFailed(documentId, errorMessage) {
  const { rows } = await sql`
    UPDATE patient_documents
    SET extraction_status = 'failed', extraction_error = ${errorMessage || 'Unknown error'}
    WHERE id = ${documentId}
    RETURNING *
  `;
  return rows[0];
}

export async function getPatientDocuments(patientId) {
  const { rows } = await sql`
    SELECT * FROM patient_documents
    WHERE patient_id = ${patientId}
    ORDER BY created_at DESC
  `;
  return rows;
}

export async function getPatientDocumentById(documentId) {
  const { rows } = await sql`
    SELECT * FROM patient_documents WHERE id = ${documentId} LIMIT 1
  `;
  return rows[0] || null;
}

// Session Answer Management (Temporary storage for voice feedback collection)
// Answers are stored here during the conversation and only committed to
// feedback_form when all 27 questions are answered

export async function saveSessionAnswer(patientId, sessionId, questionId, answerValue) {
  if (!QUESTION_ID_MAP[questionId]) {
    throw new Error(
      `Invalid question_id: "${questionId}". Valid IDs: ${Object.keys(QUESTION_ID_MAP).join(', ')}`
    );
  }

  const { rows } = await sql`
    INSERT INTO session_answers (patient_id, session_id, question_id, answer_value)
    VALUES (${patientId}, ${sessionId}, ${questionId}, ${answerValue || null})
    ON CONFLICT (session_id, question_id) DO UPDATE SET
      answer_value = ${answerValue || null},
      updated_at = now()
    RETURNING *
  `;

  console.log(`[DB] Session answer saved: patient:${patientId} session:${sessionId} q:${questionId}`);
  return rows[0];
}

export async function getSessionAnswers(sessionId) {
  const { rows } = await sql`
    SELECT question_id, answer_value FROM session_answers
    WHERE session_id = ${sessionId}
    ORDER BY created_at ASC
  `;
  return rows;
}

export async function isSessionComplete(sessionId) {
  const { rows } = await sql`
    SELECT COUNT(*) as count FROM session_answers
    WHERE session_id = ${sessionId}
  `;
  
  const count = parseInt(rows[0]?.count || 0, 10);
  console.log(`[DB] Session ${sessionId} has ${count} answers`);
  return count === 27;
}

// Every answer is now written straight to feedback_form as it's collected (see
// updateFeedbackAnswer), so this no longer builds/writes the form itself — doing so
// here from session_answers alone would null out any column not present in that
// session (e.g. the patient stopped early), overwriting good data already saved.
// This is now just bookkeeping: report how many of the 27 questions were answered
// and clear the session_answers staging rows, regardless of completeness.
export async function finalizeSessionAnswers(patientId, sessionId) {
  try {
    const answers = await getSessionAnswers(sessionId);
    const count = answers.length;

    console.log(`[DB] Finalizing session ${sessionId}: ${count}/27 answers collected`);

    const { rows: existing } = await sql`
      SELECT id FROM feedback_form
      WHERE patient_id = ${patientId} AND feedback_date = CURRENT_DATE
      LIMIT 1
    `;

    await sql`
      DELETE FROM session_answers WHERE session_id = ${sessionId}
    `;

    return {
      success: true,
      feedback_form_id: existing[0]?.id ?? null,
      answers_collected: count,
      complete: count >= 27,
      finalized: true,
      created_at: new Date().toISOString(),
    };
  } catch (error) {
    console.error(`[DB] Error finalizing session ${sessionId}:`, error);
    throw error;
  }
}

export async function cleanupExpiredSessions(maxAgeHours = 24) {
  try {
    // Delete session answers older than maxAgeHours
    const { rows } = await sql`
      DELETE FROM session_answers
      WHERE updated_at < now() - interval '${maxAgeHours} hours'
      RETURNING session_id
    `;

    console.log(`[DB] Cleaned up ${rows.length} expired sessions`);
    return rows.length;
  } catch (error) {
    console.error('Error cleaning up expired sessions:', error);
    throw error;
  }
}

export async function getPatientHealthData(patientId) {
  try {
    // Fetch recent feedback (last 7 days) and reports
    const feedbackRows = await sql`
      SELECT * FROM feedback_form
      WHERE patient_id = ${patientId}
      AND created_at >= now() - interval '7 days'
      ORDER BY created_at DESC
      LIMIT 10
    `;

    const reportRows = await sql`
      SELECT * FROM reports
      WHERE patient_id = ${patientId}
      ORDER BY created_at DESC
      LIMIT 5
    `;

    const diagnosticRows = await sql`
      SELECT * FROM diagnostic_results
      WHERE patient_id = ${patientId}
      ORDER BY created_at DESC
      LIMIT 3
    `;

    // Fetch user info
    const userRows = await sql`
      SELECT id, full_name, role FROM users WHERE id = ${patientId}
    `;

    return {
      patient_id: patientId,
      patient_info: userRows.rows[0] || {},
      recent_feedback: feedbackRows.rows || [],
      reports: reportRows.rows || [],
      diagnostic_results: diagnosticRows.rows || [],
      summary: {
        feedback_count: feedbackRows.rows.length,
        report_count: reportRows.rows.length,
        diagnostic_count: diagnosticRows.rows.length,
        last_feedback_date: feedbackRows.rows[0]?.created_at || null,
      },
    };
  } catch (error) {
    console.error('[DB] Error fetching patient health data:', error);
    throw error;
  }
}
