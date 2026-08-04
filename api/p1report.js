import { ensureSchema, insertP1ReportForm, getP1ReportFormByPatient } from './_db.js'
import { requireAuth } from './_auth.js'
// TODO(voice-agent): n8n diagnostic-generation trigger removed from here. Re-wire to
// whatever replaces it in Stage 2+ (Claude tool-calling / direct trigger).

// Field name mapping from form to database columns
// Maps form field names (after dash-to-underscore conversion) to database column names
const FORM_TO_DB_MAPPING = {
  'date_of_birth': 'date_of_birth',
  'age': 'age',
  'gender': 'gender',
  'height': 'height',
  'weight': 'weight',
  'bmi': 'bmi',
  'ethnicity': 'ethnicity',
  'smoking': 'smoking',
  'smoking_duration': 'smoking_duration',
  'cigarettes_per_day': 'cigarettes_per_day',
  'alcohol': 'alcohol',
  'diet': 'diet',
  'diet_other_text': 'diet_other_text',
  'heart_attack': 'heart_attack',
  'sudden_death': 'sudden_death',
  'stroke': 'stroke',
  'heart_failure': 'heart_failure',
  'heart_rhythm': 'heart_rhythm',
  'heart_defect': 'heart_defect',
  'blood_pressure': 'blood_pressure',
  'diabetes': 'diabetes',
  'cholesterol': 'cholesterol',
  'cancer': 'cancer',
  'other_illness_text': 'other_illness_text',
  'nyha': 'nyha',
  'acc_stage': 'acc_stage',
  'diabetes_type_1': 'diabetes_type_1',
  'diabetes_type_2': 'diabetes_type_2',
  'metabolic_syndrome': 'metabolic_syndrome',
  'dyslipidemia': 'dyslipidemia',
  'thyroid_dysfunction': 'thyroid_dysfunction',
  'on_dialysis': 'on_dialysis',
  'coagulation_liver_disease': 'coagulation_liver_disease',
  'anemia': 'anemia',
  'chronic_liver_disease': 'chronic_liver_disease',
  'chronic_bronchial': 'chronic_bronchial',
  'pulmonary_hypertension': 'pulmonary_hypertension',
  'sleep_apnea': 'sleep_apnea',
  'primary_tumor': 'primary_tumor',
  'autoimmune': 'autoimmune',
  'depression_anxiety': 'depression_anxiety',
  'preeclampsia': 'preeclampsia',
  'hellp': 'hellp',
  'pci': 'pci',
  'cabg': 'cabg',
  'svr': 'svr',
  'tavi': 'tavi',
  'septal_myectomy_2': 'septal_myectomy_2',
  'myectomy_year': 'myectomy_year',
  'cardiac_pacemaker': 'cardiac_pacemaker',
  'cardiac_pacemaker_year': 'cardiac_pacemaker_year',
  'cardiac_icd': 'cardiac_icd',
  'cardiac_icd_year': 'cardiac_icd_year',
  'cardiac_crt': 'cardiac_crt',
  'cardiac_crt_year': 'cardiac_crt_year',
  'cardiac_catheter_ablation': 'cardiac_catheter_ablation',
  'cardiac_catheter_ablation_year': 'cardiac_catheter_ablation_year',
  'cardiac_maze_procedure': 'cardiac_maze_procedure',
  'cardiac_maze_procedure_year': 'cardiac_maze_procedure_year',
  'lvad_implementation': 'lvad_implementation',
  'lvad_implementation_year': 'lvad_implementation_year',
  'heart_transplant': 'heart_transplant',
  'heart_transplant_year': 'heart_transplant_year',
  'pulmonary_thromboendarterectomy': 'pulmonary_thromboendarterectomy',
  'pulmonary_thromboendarterectomy_year': 'pulmonary_thromboendarterectomy_year',
  'aortic_aneurysm': 'aortic_aneurysm',
  'aortic_aneurysm_year': 'aortic_aneurysm_year',
  'thoracic_surgery': 'thoracic_surgery',
  'thoracic_surgery_year': 'thoracic_surgery_year',
  'abdominal_surgeries': 'abdominal_surgeries',
  'abdominal_surgeries_year': 'abdominal_surgeries_year',
  'ace_inhibitors': 'ace_inhibitors',
  'ace_inhibitors_drugs': 'ace_inhibitors_drugs',
  'arbs_2': 'arbs_2',
  'arb_drugs': 'arb_drugs',
  'beta_blockers': 'beta_blockers',
  'beta_blockers_drugs': 'beta_blockers_drugs',
  'calcium_channel_blockers': 'calcium_channel_blockers',
  'calcium_channel_blockers_drugs': 'calcium_channel_blockers_drugs',
  'diuretics_tablets': 'diuretics_tablets',
  'diuretics_tablets_drugs': 'diuretics_tablets_drugs',
  'other_heart_failure_medications': 'other_heart_failure_medications',
  'other_heart_failure_medications_drugs': 'other_heart_failure_medications_drugs',
  'nitrates': 'nitrates',
  'nitrates_drugs': 'nitrates_drugs',
  'antiarryhthmic_drugs': 'antiarryhthmic_drugs',
  'antiarryhthmic_drugs_drugs': 'antiarryhthmic_drugs_drugs',
  'antiplatelet_medication': 'antiplatelet_medication',
  'antiplatelet_medication_drugs': 'antiplatelet_medication_drugs',
  'oral_anticoagulants': 'oral_anticoagulants',
  'oral_anticoagulants_drugs': 'oral_anticoagulants_drugs',
  'statins': 'statins',
  'statins_drugs': 'statins_drugs',
  'other_lipid_lowering_drugs': 'other_lipid_lowering_drugs',
  'other_lipid_lowering_drugs_drugs': 'other_lipid_lowering_drugs_drugs',
  'medication_for_diabetes': 'medication_for_diabetes',
  'medication_for_diabetes_drugs': 'medication_for_diabetes_drugs',
  'medication_thyroid': 'medication_thyroid',
  'medication_thyroid_drugs': 'medication_thyroid_drugs',
  'medication_for_antidepressant': 'medication_for_antidepressant',
  'medication_for_antidepressant_drugs': 'medication_for_antidepressant_drugs',
  'anti_anxiety': 'anti_anxiety',
  'anti_anxiety_drugs': 'anti_anxiety_drugs',
  'other_medication': 'other_medication',

  
  'timing_and_type_input': 'timing_and_type_input',
  'failure_phenotype': 'failure_phenotype',
  'clinical_ischemia': 'clinical_ischemia',
  'prior_myocardial': 'prior_myocardial',
  'coronary_artery_disease': 'coronary_artery_disease',
  'hypotension': 'hypotension',
  'pleural_effusion': 'pleural_effusion',
  'jugular_venous_distension': 'jugular_venous_distension',
  'cardiac_index': 'cardiac_index',
  'cardiac_index_not_measured': 'cardiac_index_not_measured',
  'systemic_vascular_resistance': 'systemic_vascular_resistance',
  'systemic_vascular_resistance_not_measured': 'systemic_vascular_resistance_not_measured',
  'right_atrial_pressure': 'right_atrial_pressure',
  'right_atrial_pressure_not_measured': 'right_atrial_pressure_not_measured',
  'right_ventricular_pressure': 'right_ventricular_pressure',
  'right_ventricular_pressure_not_measured': 'right_ventricular_pressure_not_measured',
  'pulmonary_artery_pressure': 'pulmonary_artery_pressure',
  'pulmonary_artery_pressure_not_measured': 'pulmonary_artery_pressure_not_measured',
  'pulmonary_capillary_wedge_pressure': 'pulmonary_capillary_wedge_pressure',
  'pulmonary_capillary_wedge_pressure_not_measured': 'pulmonary_capillary_wedge_pressure_not_measured',
  'aortic_pressure_during_cath': 'aortic_pressure_during_cath',
  'aortic_pressure_during_cath_not_measured': 'aortic_pressure_during_cath_not_measured',
  'pulmonary_vascular_resistance': 'pulmonary_vascular_resistance',
  'pulmonary_vascular_resistance_not_measured': 'pulmonary_vascular_resistance_not_measured',
  'pulmonary_hypertension_catheter': 'pulmonary_hypertension_catheter',
  'troponin_i': 'troponin_i',
  'troponin_t': 'troponin_t',
  'nt_probnp': 'nt_probnp',
  'bnp': 'bnp',
  'bnp_not_measured': 'bnp_not_measured',
  'ck_mb': 'ck_mb',
  'ck_mb_not_measured': 'ck_mb_not_measured',
  'myoglobin': 'myoglobin',
  'myoglobin_not_measured': 'myoglobin_not_measured',
  'ldh': 'ldh',
  'ldh_not_measured': 'ldh_not_measured',
  'crp': 'crp',
  'ddimer': 'ddimer',
  'homocysteine': 'homocysteine',
  'ldl': 'ldl',
  'hdl': 'hdl',
  'triglycerides': 'triglycerides',
  'hba1c': 'hba1c',
  'bun': 'bun',
  'creatinine': 'creatinine',
  'blood_ph': 'blood_ph',
  'ketones': 'ketones',
  'sodium': 'sodium',
  'potassium': 'potassium',
  'calcium': 'calcium',
  'calcium_not_assessed': 'calcium_not_assessed',
  'magnesium': 'magnesium',
  'magnesium_not_assessed': 'magnesium_not_assessed',
  'chloride': 'chloride',
  'chloride_not_assessed': 'chloride_not_assessed',
  'tsh': 'tsh',
  'tsh_not_assessed': 'tsh_not_assessed',
  'free_t3': 'free_t3',
  'free_t3_not_assessed': 'free_t3_not_assessed',
  'free_t4': 'free_t4',
  'free_t4_not_assessed': 'free_t4_not_assessed',
  'testosterone': 'testosterone',
  'testosterone_not_assessed': 'testosterone_not_assessed',
  'ferritin': 'ferritin',
  'transferrin_saturation': 'transferrin_saturation',
  'coronary_artery_calcium': 'coronary_artery_calcium',
  'periphral_artery': 'periphral_artery',
  'right_ankle_brachial': 'right_ankle_brachial',
  'right_ankle_brachial_not_assessed': 'right_ankle_brachial_not_assessed',
  'left_ankle_brachial': 'left_ankle_brachial',
  'left_ankle_brachial_not_assessed': 'left_ankle_brachial_not_assessed',
  'aa_ad': 'aa_ad',
  'chd': 'chd',
  'endocarditis1': 'endocarditis1',
  'myocarditis1': 'myocarditis1',
  'pericarditis1': 'pericarditis1',
  'disease_present': 'disease_present',
  'disease_present_result': 'disease_present_result',
  'disease_present2': 'disease_present2',
  'disease_present2_result': 'disease_present2_result',
  'disease_present3': 'disease_present3',
  'disease_present3_result': 'disease_present3_result',
  'disease_present4': 'disease_present4',
  'disease_present4_result': 'disease_present4_result',
  'asymptomatic_valvular': 'asymptomatic_valvular',
  'murmur_present': 'murmur_present',
  's3': 's3',
  's4': 's4',
  'summary': 'summary',
  'lv_size': 'lv_size',
  'lvedv': 'lvedv',
  'lvedv_not_assessed': 'lvedv_not_assessed',
  'lvesv': 'lvesv',
  'lvesv_not_assessed': 'lvesv_not_assessed',
  'lvef': 'lvef',
  'lvef_not_assessed': 'lvef_not_assessed',
  'fs': 'fs',
  'fs_not_assessed': 'fs_not_assessed',
  'lv_mass': 'lv_mass',
  'lv_mass_not_assessed': 'lv_mass_not_assessed',
  'lv_mass_index': 'lv_mass_index',
  'lv_mass_index_not_assessed': 'lv_mass_index_not_assessed',
  'gls': 'gls',
  'gls_not_assessed': 'gls_not_assessed',
  'cd_on_imaging': 'cd_on_imaging',
  'lv_hypertrophy': 'lv_hypertrophy',
  'e_e_prime_ratio': 'e_e_prime_ratio',
  'ejection_time': 'ejection_time',
  'ejection_time_not_assessed': 'ejection_time_not_assessed',
  'cardiac_output': 'cardiac_output',
  'cardiac_output_not_assessed': 'cardiac_output_not_assessed',
  'rv_size': 'rv_size',
  'rv_diameter': 'rv_diameter',
  'rv_diameter_not_assessed': 'rv_diameter_not_assessed',
  'rv_wall_thickness': 'rv_wall_thickness',
  'rv_wall_thickness_not_assessed': 'rv_wall_thickness_not_assessed',
  'rv_ejection_fraction': 'rv_ejection_fraction',
  'rv_ejection_fraction_not_assessed': 'rv_ejection_fraction_not_assessed',
  'rv_tapse': 'rv_tapse',
  'rv_tapse_not_assessed': 'rv_tapse_not_assessed',
  'left_atrial_volume': 'left_atrial_volume',
  'left_atrial_volume_not_assessed': 'left_atrial_volume_not_assessed',
  'aortic_root_diameter': 'aortic_root_diameter',
  'aortic_root_diameter_not_assessed': 'aortic_root_diameter_not_assessed',
  'ascending_aorta_diameter': 'ascending_aorta_diameter',
  'ascending_aorta_diameter_not_assessed': 'ascending_aorta_diameter_not_assessed',
  'ivc_diameter': 'ivc_diameter',
  'ivc_diameter_not_assessed': 'ivc_diameter_not_assessed',
  'ivc_collapsibility_index': 'ivc_collapsibility_index',
  'ivc_collapsibility_index_not_assessed': 'ivc_collapsibility_index_not_assessed',
  'wall_motion_abnormalities': 'wall_motion_abnormalities',
  'valvular_function': 'valvular_function',
  'valve_area': 'valve_area',
  'pressure_peak': 'pressure_peak',
  'pressure_mean': 'pressure_mean',
  'pressure_gradients_not_assessed': 'pressure_gradients_not_assessed',
  'regurgitation_volume': 'regurgitation_volume',
  'regurgitation_volume_not_assessed': 'regurgitation_volume_not_assessed',
  'regurgitation_fraction': 'regurgitation_fraction',
  'regurgitation_fraction_not_assessed': 'regurgitation_fraction_not_assessed',
  'valvular_disease_severity': 'valvular_disease_severity',
  'summary1': 'summary1',
}

export default async function handler(req, res) {
  try {
    const auth = requireAuth(req)
    if (!auth) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    await ensureSchema()

    if (req.method === 'POST') {
      if (auth.role !== 'doctor') { 
        res.status(403).json({ error: 'Forbidden' })
        return 
      }
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const body = Buffer.concat(chunks).toString()
      let payload = {}
      try { 
        payload = JSON.parse(body || '{}') 
      } catch (parseError) {
        console.error('JSON parse error:', parseError)
        res.status(400).json({ error: 'Invalid JSON payload' })
        return
      }
      const { patientId, ...rest } = payload || {}
      if (!patientId) { 
        res.status(400).json({ error: 'Missing patientId' })
        return 
      }
      
      // Clean field names and apply mapping
      const form = {}
      Object.keys(rest || {}).forEach((k) => { 
        // First, normalize the field name (convert special chars to underscores)
        const normalized = k.replace(/[^a-zA-Z0-9_]/g, '_').replace(/_+/g, '_')
        
        // Then, apply the mapping to get the correct database column name
        const dbFieldName = FORM_TO_DB_MAPPING[normalized] || normalized
        
        form[dbFieldName] = rest[k]
      })
      
      console.log(`[p1report] Attempting to save P1 report for patient ${patientId}`)
      console.log(`[p1report] Received ${Object.keys(rest || {}).length} form fields`)
      console.log(`[p1report] Mapped to ${Object.keys(form).length} database fields`)
      
      try {
        const row = await insertP1ReportForm(Number(patientId), form)
        console.log(`[p1report] Successfully saved P1 report with ID: ${row.id}`)

        // TODO(voice-agent): n8n diagnostic-generation trigger removed. Re-wire this
        // to whatever replaces it in Stage 2+ (Claude tool-calling / direct trigger).

        res.status(200).json({ id: row.id })
      } catch (dbError) {
        console.error('[p1report] Database error:', dbError)
        res.status(500).json({ error: 'Failed to save form: ' + dbError.message })
      }
      return
    }

    if (req.method === 'GET') {
      const url = new URL(req.url, 'http://localhost')
      const patientIdParam = url.searchParams.get('patientId')
      if (!patientIdParam) { 
        res.status(400).json({ error: 'Missing patientId' })
        return 
      }
      if (auth.role !== 'doctor' && Number(patientIdParam) !== auth.sub) { 
        res.status(403).json({ error: 'Forbidden' })
        return 
      }
      const rows = await getP1ReportFormByPatient(Number(patientIdParam))
      res.status(200).json({ items: rows })
      return
    }

    res.status(405).json({ error: 'Method Not Allowed' })
  } catch (error) {
    console.error('P1 report API error:', error)
    res.status(500).json({ error: 'Internal server error: ' + error.message })
  }
}


