// Helper function to format dates
function formatDateValue(value) {
  // List of date field names
  const dateFields = ['date_of_birth', 'feedback_date'];
  
  // Check if value is a date string (ISO format like 2000-01-15T00:00:00.000Z)
  if (value && typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    try {
      const date = new Date(value);
      // Return formatted date: "Jan 15, 2000" or just the date part "2000-01-15"
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    } catch (e) {
      return value; // Return original if parsing fails
    }
  }
  return value;
}

// Once a doctor lands on report1.html?patientId=X, every Back/Next link on every
// report1.*.html page needs to keep carrying that param forward — otherwise the
// very next click silently drops back to the doctor's own (nonexistent) data.
function preservePatientIdInNavLinks() {
  const patientIdParam = new URLSearchParams(location.search).get('patientId');
  if (!patientIdParam) return;
  const role = localStorage.getItem('role');
  document.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href');
    if (href && /^report1(\.\d+)?\.html$/.test(href)) {
      a.setAttribute('href', `${href}?patientId=${encodeURIComponent(patientIdParam)}`);
    } else if (role === 'doctor' && href === 'patient1.html') {
      // report1.html's own "Back" link assumes a patient viewing their own report,
      // so it always points at the patient dashboard — wrong for a doctor, who has
      // no patient1.html of their own. Send them back to this patient's P1report
      // page instead.
      a.setAttribute('href', `P1report.html?patientId=${encodeURIComponent(patientIdParam)}`);
    }
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  const token = localStorage.getItem('token');
  const role = localStorage.getItem('role');
  if (!token) { window.location.href = 'index.html'; return; }

  preservePatientIdInNavLinks();

  try {
    // A doctor viewing a specific patient's reports arrives with ?patientId= in the
    // URL (see P1report.html's "View Full Report" link) — thread it through so
    // /api/reports resolves that patient instead of the logged-in doctor's own id.
    const patientIdParam = new URLSearchParams(location.search).get('patientId');
    const reportsUrl = patientIdParam
      ? `/api/reports?patientId=${encodeURIComponent(patientIdParam)}`
      : '/api/reports';
    const res = await fetch(reportsUrl, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await res.json();
    if (!res.ok) {
      console.error('Failed loading report:', data.error);
      return;
    }
    
    // data.reports: doctor reports
    // data.feedback: daily feedback_form entries  
    // data.p1forms: doctor p1_report_form entries
    
    console.log('Report data:', data);
    
    // Display feedback data in the page
    displayFeedbackData(data.feedback || []);
    displayDoctorReports(data.reports || []);
    displayDiagnosticResults(data.diagnostics || []);
    displayP1Forms(data.p1forms || []);
    
    // After displaying data, replace any remaining "Loading..." with "-"
    replaceLoadingText();
    
  } catch (error) {
    console.error('Network error loading reports:', error);
    // Even on error, replace loading text
    replaceLoadingText();
  }
});

function replaceLoadingText() {
  // Find all elements with "Loading..." and replace with "-"
  const loadingElements = document.querySelectorAll('*');
  loadingElements.forEach(element => {
    if (element.textContent && element.textContent.trim() === 'Loading...') {
      element.textContent = '-';
    }
  });
  console.log('Replaced all "Loading..." with "-"');
}

function displayFeedbackData(feedbackList) {
  if (feedbackList.length === 0) {
    console.log('No feedback data found');
    return;
  }
  
  // Get the most recent feedback entry
  const latestFeedback = feedbackList[0];
  
  // Map feedback field names to HTML element IDs 
  const feedbackMapping = {
    'dyspnea': 'dyspnea',
    'orthopnea': 'orthopnea',
    'paroxysmal_nocturnal_dyspnea': 'paroxysmal_nocturnal_dyspnea',
    'cyanosis': 'cyanosis',
    'jugular_venous_distension': 'jugular_venous_distension',
    'nighttime_urination_count': 'nighttime_urination_count',
    'chest_pain': 'chest_pain',
    'arm_pain': 'arm_pain',
    'leg_pain': 'leg_pain',
    'jaw_pain': 'jaw_pain',
    'back_pain': 'back_pain',
    'stomach_pain': 'stomach_pain',
    'headache': 'headache',
    'numb_arms_legs': 'numb_arms_legs',
    'visual_disturbances': 'visual_disturbances',
    'palpitations': 'palpitations',
    'sweating': 'sweating',
    'leg_swelling': 'leg_swelling',
    'abdominal_bloating': 'abdominal_bloating',
    'weight_kg': 'weight_kg',
    'walk_6min_distance_m': 'walk_6min_distance_m',
    'blood_pressure_systolic': 'blood_pressure_systolic',
    'blood_pressure_diastolic': 'blood_pressure_diastolic',
    'fatigue_level': 'fatigue_level',
    'sleep_quality': 'sleep_quality',
    'anxious': 'anxious',
    'erectile_dysfunction': 'erectile_dysfunction',
    'free_comment': 'free_comment'
  };

  // Populate feedback data
  Object.keys(feedbackMapping).forEach(fieldName => {
    const value = latestFeedback[fieldName];
    const elementId = feedbackMapping[fieldName];
    const element = document.getElementById(elementId);
    if (element) {
      if (value === null || value === undefined) {
        // For null/undefined values, show "-"
        element.textContent = '-';
        console.log(`Updated #${elementId} with "-" (was null/undefined)`);
      } else if (value === 'n.A') {
        // For "n.A" values, show as "-"
        element.textContent = '-';
        console.log(`Updated #${elementId} with "-" (was n.A)`);
      } else {
        // For actual values, show them (with date formatting if applicable)
        element.textContent = formatDateValue(value);
        console.log(`Updated #${elementId} with value: ${formatDateValue(value)}`);
      }
    }
  });

  // free_text holds AI follow-up answers collected during the voice check-in —
  // separate from the structured fields above, shown in its own section.
  const freeTextElement = document.getElementById('free_text');
  if (freeTextElement) {
    const freeText = latestFeedback.free_text;
    freeTextElement.textContent = (freeText && freeText.trim())
      ? freeText
      : 'No follow-up notes for this check-in.';
  }

  console.log('Latest feedback displayed:', latestFeedback);
}

function displayDoctorReports(reports) {
  if (reports.length === 0) {
    console.log('No doctor reports found');
    return;
  }
  
  console.log('Doctor reports:', reports);
  
  // For now, just log the doctor reports as they don't have a specific UI section yet
  // In the future, these could be displayed in a dedicated section showing:
  // - Doctor name (report.doctor_name)
  // - Sick status (report.sick_status) 
  // - Notes (report.notes)
  // - Diagnosis (report.diagnosis)
  // - Date (report.created_at)
  
  reports.forEach((report, index) => {
    console.log(`Doctor Report ${index + 1}:`, {
      doctor: report.doctor_name,
      status: report.sick_status,
      diagnosis: report.diagnosis,
      notes: report.notes,
      date: report.created_at
    });
  });
}

function displayDiagnosticResults(diagnosticsList) {
  if (diagnosticsList.length === 0) {
    console.log('No diagnostic results found');
    return;
  }
  
  // Get the most recent diagnostic result
  const latestDiagnostic = diagnosticsList[0];
  console.log('Latest diagnostic result:', latestDiagnostic);
  
  // Map diagnostic fields to HTML element IDs for report1.7.html
  const diagnosticMapping = {
    // Risk Assessment
    'risk_level': 'risk-level',
    'risk_percentage': 'risk-percentage',
    'confidence_level': 'confidence-level',
    
    // Clinical Assessment
    'clinical_assessment': 'clinical-assessment-text',
    'detailed_recommendations': 'detailed-recommendations-text',
    
    // Summary Information
    'summary': 'diagnostic-summary-text',
    'diagnostic_summary': 'diagnostic-summary-detailed',
    'prognosis_note': 'prognosis-note',
    
    // Clinical Plan
    'monitoring_plan': 'monitoring-plan-text',
    'follow_up_timeline': 'follow-up-timeline-text',
    
    // Metadata
    'generated_at': 'report-generated-date',
    'report_version': 'report-version',
    'analysis_model': 'analysis-model'
  };
  
  // Populate simple text fields
  Object.keys(diagnosticMapping).forEach(fieldName => {
    const value = latestDiagnostic[fieldName];
    const elementId = diagnosticMapping[fieldName];
    const element = document.getElementById(elementId);
    
    if (element && value) {
      element.textContent = value;
      console.log(`Updated diagnostic #${elementId} with: ${value}`);
    }
  });
  
  // Display Condition-Specific Risk Assessments
  if (latestDiagnostic.condition_risk_assessments) {
    const conditionRisks = latestDiagnostic.condition_risk_assessments;
    const conditionContainer = document.getElementById('condition-risk-assessments');
    
    if (conditionContainer) {
      conditionContainer.innerHTML = '';
      
      // Map snake_case to display names
      const conditionNames = {
        'myocardial_infarction': 'Myocardial Infarction',
        'stroke': 'Stroke',
        'sudden_cardiac_death': 'Sudden Cardiac Death',
        'coronary_artery_disease': 'Coronary Artery Disease',
        'heart_failure': 'Heart Failure',
        'atrial_fibrillation': 'Atrial Fibrillation',
        'hypertrophic_cardiomyopathy': 'Hypertrophic Cardiomyopathy',
        'dilated_cardiomyopathy': 'Dilated Cardiomyopathy',
        'pulmonary_embolism': 'Pulmonary Embolism',
        'aortic_dissection': 'Aortic Dissection',
        'endocarditis': 'Risk of Endocarditis',
        'peripheral_artery_disease': 'Peripheral Artery Disease',
        'complete_heart_block': 'Complete Heart Block',
        'cardiac_arrest': 'Cardiac Arrest',
        'angina_pectoris': 'Angina Pectoris',
        'pulmonary_hypertension': 'Pulmonary Hypertension',
        'pericarditis': 'Risk of Pericarditis',
        'pulmonary_edema': 'Pulmonary Edema',
        'peripheral_edema': 'Peripheral Edema'
      };
      
      Object.keys(conditionNames).forEach(key => {
        const displayName = conditionNames[key];
        const riskLevel = conditionRisks[key] || 'Not assessed';
        
        const row = document.createElement('div');
        row.className = `condition-risk-row risk-${riskLevel.toLowerCase().replace(/\s+/g, '-')}`;
        row.innerHTML = `
          <span class="condition-name">${displayName}</span>
          <span class="condition-risk-badge">${riskLevel}</span>
        `;
        
        conditionContainer.appendChild(row);
      });
      
      console.log('Populated condition risk assessments');
    }
  }
  
  // Populate array fields (risk factors, findings, recommendations, etc.)
  const arrayFields = {
    'risk_factors': 'risk-factors-list',
    'key_findings': 'key-findings-list',
    'cardiac_recommendations': 'recommendations-list',
    'lifestyle_modifications': 'lifestyle-list',
    'urgent_concerns': 'urgent-concerns-list'
  };
  
  Object.keys(arrayFields).forEach(fieldName => {
    const arrayValue = latestDiagnostic[fieldName];
    const elementId = arrayFields[fieldName];
    const container = document.getElementById(elementId);
    
    if (container && arrayValue && Array.isArray(arrayValue)) {
      container.innerHTML = '';
      arrayValue.forEach(item => {
        const li = document.createElement('li');
        li.textContent = item;
        container.appendChild(li);
      });
      console.log(`Populated ${elementId} with ${arrayValue.length} items`);
    }
  });
  
  // Populate data source indicators
  if (latestDiagnostic.has_feedback_data !== undefined) {
    const feedbackEl = document.getElementById('source-feedback-indicator');
    if (feedbackEl) feedbackEl.textContent = latestDiagnostic.has_feedback_data ? '✓' : '✗';
  }
  
  if (latestDiagnostic.has_report_data !== undefined) {
    const reportEl = document.getElementById('source-report-indicator');
    if (reportEl) reportEl.textContent = latestDiagnostic.has_report_data ? '✓' : '✗';
  }
  
  if (latestDiagnostic.has_ecg_data !== undefined) {
    const ecgEl = document.getElementById('source-ecg-indicator');
    if (ecgEl) ecgEl.textContent = latestDiagnostic.has_ecg_data ? '✓' : '✗';
  }
  
  console.log('Diagnostic results displayed successfully');
}

// Map P1 form database fields to HTML -display elements (for report pages)
function populateDisplayElements(p1Data) {
  const displayMapping = {
    // Cardiac Procedures - display elements on report1.2.html
    'pci': 'pci-display',
    'cabg': 'cabg-display',
    'svr': 'svr-display',
    'tavi': 'tavi-display',
    'septal_myectomy_2': 'septal-myectomy-display',
    'myectomy_year': 'myectomy-year-display',
    'cardiac_pacemaker': 'cardiac-pacemaker-display',
    'cardiac_pacemaker_year': 'cardiac-pacemaker-year-display',
    'cardiac_icd': 'cardiac-icd-display',
    'cardiac_icd_year': 'cardiac-icd-year-display',
    'cardiac_crt': 'cardiac-crt-display',
    'cardiac_crt_year': 'cardiac-crt-year-display',
    'cardiac_catheter_ablation': 'cardiac-catheter-ablation-display',
    'cardiac_catheter_ablation_year': 'cardiac-catheter-ablation-year-display',
    'cardiac_maze_procedure': 'cardiac-maze-procedure-display',
    'cardiac_maze_procedure_year': 'cardiac-maze-procedure-year-display',
    'lvad_implementation': 'lvad-implementation-display',
    'lvad_implementation_year': 'lvad-implementation-year-display',
    'heart_transplant': 'heart-transplant-display',
    'heart_transplant_year': 'heart-transplant-year-display',
    'pulmonary_thromboendarterectomy': 'pulmonary-thromboendarterectomy-display',
    'pulmonary_thromboendarterectomy_year': 'pulmonary-thromboendarterectomy-year-display',
    'aortic_aneurysm': 'aortic-aneurysm-display',
    'aortic_aneurysm_year': 'aortic-aneurysm-year-display',
    'thoracic_surgery': 'thoracic-surgery-display',
    'thoracic_surgery_year': 'thoracic-surgery-year-display',
    'abdominal_surgeries': 'abdominal-surgeries-display',
    'abdominal_surgeries_year': 'abdominal-surgeries-year-display',
    
    // Medications - display elements on report1.3.html
    'ace_inhibitors': 'ace-inhibitors-display',
    'ace_inhibitors_drugs': 'ace-inhibitors-drugs-display',
    'arbs_2': 'arbs-2-display',
    'arb_drugs': 'arb-drugs-display',
    'beta_blockers': 'beta-blockers-display',
    'beta_blockers_drugs': 'beta-blockers-drugs-display',
    'calcium_channel_blockers': 'calcium-channel-blockers-display',
    'calcium_channel_blockers_drugs': 'calcium-channel-blockers-drugs-display',
    'diuretics_tablets': 'diuretics-tablets-display',
    'diuretics_tablets_drugs': 'diuretics-tablets-drugs-display',
    'other_heart_failure_medications': 'other-heart-failure-medications-display',
    'other_heart_failure_medications_drugs': 'other-heart-failure-medications-drugs-display',
    'nitrates': 'nitrates-display',
    'nitrates_drugs': 'nitrates-drugs-display',
    'antiarryhthmic_drugs': 'antiarryhthmic-drugs-display',
    'antiarryhthmic_drugs_drugs': 'antiarryhthmic-drugs-drugs-display',
    'antiplatelet_medication': 'antiplatelet-medication-display',
    'antiplatelet_medication_drugs': 'antiplatelet-medication-drugs-display',
    'oral_anticoagulants': 'oral-anticoagulants-display',
    'oral_anticoagulants_drugs': 'oral-anticoagulants-drugs-display',
    'statins': 'statins-display',
    'statins_drugs': 'statins-drugs-display',
    'other_lipid_lowering_drugs': 'other-lipid-lowering-drugs-display',
    'other_lipid_lowering_drugs_drugs': 'other-lipid-lowering-drugs-drugs-display',
    'medication_for_diabetes': 'medication-for-diabetes-display',
    'medication_for_diabetes_drugs': 'medication-for-diabetes-drugs-display',
    'medication_thyroid': 'medication-thyroid-display',
    'medication_thyroid_drugs': 'medication-thyroid-drugs-display',
    'medication_for_antidepressant': 'medication-for-antidepressant-display',
    'medication_for_antidepressant_drugs': 'medication-for-antidepressant-drugs-display',
    'anti_anxiety': 'anti-anxiety-display',
    'anti_anxiety_drugs': 'anti-anxiety-drugs-display',
    'other_medication': 'other-medication-display',
    
    // Current Medications section on report1.3.html (if different elements)
    // Last Cardio Evaluation fields - display elements on report1.3.html
    'timing_and_type_input': 'timing-and-type-input-display',
    'failure_phenotype': 'failure-phenotype-display',
    'clinical_ischemia': 'clinical-ischemia-display',
    'prior_myocardial': 'prior-myocardial-display',
    'coronary_artery_disease': 'coronary-artery-disease-display',
    'hypotension': 'hypotension-display',
    'pleural_effusion': 'pleural-effusion-display',
  };
  
  let displayFieldsUpdated = 0;
  let displayFieldsNotFound = 0;
  
  Object.keys(displayMapping).forEach(fieldName => {
    const value = p1Data[fieldName];
    const elementId = displayMapping[fieldName];
    let element = document.getElementById(elementId);
    
    // If element with -display suffix not found, try without suffix
    if (!element && elementId.endsWith('-display')) {
      const plainId = elementId.replace('-display', '');
      element = document.getElementById(plainId);
      if (element) {
        console.log(`Using plain ID #${plainId} for field ${fieldName}`);
      }
    }
    
    if (element) {
      if (value === null || value === undefined) {
        element.textContent = '-';
        console.log(`Updated display #${element.id} with "-" (was null/undefined)`);
      } else if (value === 'n.A') {
        element.textContent = '-';
        console.log(`Updated display #${element.id} with "-" (was n.A)`);
      } else {
        element.textContent = formatDateValue(value);
        console.log(`Updated display #${element.id} with value: ${formatDateValue(value)}`);
      }
      displayFieldsUpdated++;
    } else {
      console.log(`Display element #${elementId} not found for field ${fieldName}`);
      displayFieldsNotFound++;
    }
  });
  
  console.log(`Display Elements Summary: ${displayFieldsUpdated} fields updated, ${displayFieldsNotFound} elements not found`);
}

function displayP1Forms(p1forms) {
  if (p1forms.length === 0) {
    console.log('No P1 forms found');
    return;
  }
  
  // Get the most recent P1 form entry
  const latestP1 = p1forms[0];
  console.log('Latest P1 form data:', latestP1);
  
  // Merge additional_fields into the main object for easier processing
  const allP1Data = { ...latestP1 };
  if (latestP1.additional_fields) {
    Object.assign(allP1Data, latestP1.additional_fields);
    console.log(`Found ${Object.keys(latestP1.additional_fields).length} additional fields in P1 data`);
    console.log('Additional fields:', latestP1.additional_fields);
  }
  
  console.log('All P1 data (merged):', allP1Data);
  
  // First, populate elements with -display suffix (for report pages)
  populateDisplayElements(allP1Data);
  
  // Then populate regular elements (for form page)
  // Map P1 form field names to HTML element IDs (matches _db.js schema exactly)
  const p1Mapping = {
    // Page 1: General Information
    'date_of_birth': 'date-of-birth',
    'age': 'age',
    'gender': 'gender',
    'height': 'height',
    'weight': 'weight',
    'bmi': 'bmi',
    'ethnicity': 'ethnicity',
    
    // Lifestyle
    'smoking': 'smoking',
    'smoking_duration': 'smoking-duration',
    'cigarettes_per_day': 'cigarettes-per-day',
    'alcohol': 'alcohol',
    'diet': 'diet',
    'diet_other_text': 'diet-other-text',
    
    // Family History
    'heart_attack': 'heart-attack',
    'sudden_death': 'sudden-death',
    'stroke': 'stroke',
    'heart_failure': 'heart-failure',
    'heart_rhythm': 'heart-rhythm',
    'heart_defect': 'heart-defect',
    'blood_pressure': 'blood-pressure',
    'diabetes': 'diabetes',
    'cholesterol': 'cholesterol',
    'cancer': 'cancer',
    'other_illness_text': 'other-illness-text',
    'nyha': 'nyha',
    'acc_stage': 'acc_stage',
    
    // Medical History
    'diabetes_type_1': 'diabetes-type-1',
    'diabetes_type_2': 'diabetes-type-2',
    'metabolic_syndrome': 'metabolic-syndrome',
    'dyslipidemia': 'dyslipidemia',
    'thyroid_dysfunction': 'thyroid-dysfunction',
    'on_dialysis': 'on-dialysis',
    'coagulation_liver_disease': 'coagulation-liver-disease',
    'anemia': 'anemia',
    'chronic_liver_disease': 'chronic-liver-disease',
    'chronic_bronchial': 'chronic-bronchial',
    'pulmonary_hypertension': 'pulmonary-hypertension',
    'sleep_apnea': 'sleep-apnea',
    'primary_tumor': 'primary-tumor',
    'autoimmune': 'autoimmune',
    'depression_anxiety': 'depression-anxiety',
    'preeclampsia': 'preeclampsia',
    'hellp': 'hellp',
    
    // Procedures
    'pci': 'pci',
    'cabg': 'cabg',
    'svr': 'svr',
    'tavi': 'tavi',
    'septal_myectomy_2': 'septal-myectomy-2',
    'myectomy_year': 'myectomy-year',
    'cardiac_pacemaker': 'cardiac-pacemaker',
    'cardiac_pacemaker_year': 'cardiac-pacemaker-year',
    'cardiac_icd': 'cardiac-icd',
    'cardiac_icd_year': 'cardiac-icd-year',
    'cardiac_crt': 'cardiac-crt',
    'cardiac_crt_year': 'cardiac-crt-year',
    'cardiac_catheter_ablation': 'cardiac-catheter-ablation',
    'cardiac_catheter_ablation_year': 'cardiac-catheter-ablation-year',
    'cardiac_maze_procedure': 'cardiac-maze-procedure',
    'cardiac_maze_procedure_year': 'cardiac-maze-procedure-year',
    'lvad_implementation': 'lvad-implementation',
    'lvad_implementation_year': 'lvad-implementation-year',
    'heart_transplant': 'heart-transplant',
    'heart_transplant_year': 'heart-transplant-year',
    'pulmonary_thromboendarterectomy': 'pulmonary-thromboendarterectomy',
    'pulmonary_thromboendarterectomy_year': 'pulmonary-thromboendarterectomy-year',
    'aortic_aneurysm': 'aortic-aneurysm',
    'aortic_aneurysm_year': 'aortic-aneurysm-year',
    'thoracic_surgery': 'thoracic-surgery',
    'thoracic_surgery_year': 'thoracic-surgery-year',
    'abdominal_surgeries': 'abdominal-surgeries',
    'abdominal_surgeries_year': 'abdominal-surgeries-year',
    
    // Medications
    'ace_inhibitors': 'ace-inhibitors',
    'ace_inhibitors_drugs': 'ace-inhibitors-drugs',
    'arbs_2': 'arbs-2',
    'arb_drugs': 'arb-drugs',
    'beta_blockers': 'beta-blockers',
    'beta_blockers_drugs': 'beta-blockers-drugs',
    'calcium_channel_blockers': 'calcium-channel-blockers',
    'calcium_channel_blockers_drugs': 'calcium-channel-blockers-drugs',
    'diuretics_tablets': 'diuretics-tablets',
    'diuretics_tablets_drugs': 'diuretics-tablets-drugs',
    'other_heart_failure_medications': 'other-heart-failure-medications',
    'other_heart_failure_medications_drugs': 'other-heart-failure-medications-drugs',
    'nitrates': 'nitrates',
    'nitrates_drugs': 'nitrates-drugs',
    'antiarryhthmic_drugs': 'antiarryhthmic-drugs',
    'antiarryhthmic_drugs_drugs': 'antiarryhthmic-drugs-drugs',
    'antiplatelet_medication': 'antiplatelet-medication',
    'antiplatelet_medication_drugs': 'antiplatelet-medication-drugs',
    'oral_anticoagulants': 'oral-anticoagulants',
    'oral_anticoagulants_drugs': 'oral-anticoagulants-drugs',
    'statins': 'statins',
    'statins_drugs': 'statins-drugs',
    'other_lipid_lowering_drugs': 'other-lipid-lowering-drugs',
    'other_lipid_lowering_drugs_drugs': 'other-lipid-lowering-drugs-drugs',
    'medication_for_diabetes': 'medication-for-diabetes',
    'medication_for_diabetes_drugs': 'medication-for-diabetes-drugs',
    'medication_thyroid': 'medication-thyroid',
    'medication_thyroid_drugs': 'medication-thyroid-drugs',
    'medication_for_antidepressant': 'medication-for-antidepressant',
    'medication_for_antidepressant_drugs': 'medication-for-antidepressant-drugs',
    'anti_anxiety': 'anti-anxiety',
    'anti_anxiety_drugs': 'anti-anxiety-drugs',
    'other_medication': 'other-medication',
    
    // Timing & Type
    'timing_and_type_input': 'timing-and-type-input',
    'failure_phenotype': 'failure-phenotype',
    
    // Clinical Assessment
    'clinical_ischemia': 'clinical-ischemia',
    'prior_myocardial': 'prior-myocardial',
    'coronary_artery_disease': 'coronary-artery-disease',
    'hypotension': 'hypotension',
    'pleural_effusion': 'pleural-effusion',
    'jugular_venous_distension': 'jugular-venous-distension',
    
    // Hemodynamics
    'cardiac_index': 'cardiac-index',
    'cardiac_index_not_measured': 'cardiac-index-not-measured',
    'systemic_vascular_resistance': 'systemic-vascular-resistance',
    'systemic_vascular_resistance_not_measured': 'systemic-vascular-resistance-not-measured',
    'right_atrial_pressure': 'right-atrial-pressure',
    'right_atrial_pressure_not_measured': 'right-atrial-pressure-not-measured',
    'right_ventricular_pressure': 'right-ventricular-pressure',
    'right_ventricular_pressure_not_measured': 'right-ventricular-pressure-not-measured',
    'pulmonary_artery_pressure': 'pulmonary-artery-pressure',
    'pulmonary_artery_pressure_not_measured': 'pulmonary-artery-pressure-not-measured',
    'pulmonary_capillary_wedge_pressure': 'pulmonary-capillary-wedge-pressure',
    'pulmonary_capillary_wedge_pressure_not_measured': 'pulmonary-capillary-wedge-pressure-not-measured',
    'aortic_pressure_during_cath': 'aortic-pressure-during-cath',
    'aortic_pressure_during_cath_not_measured': 'aortic-pressure-during-cath-not-measured',
    'pulmonary_vascular_resistance': 'pulmonary-vascular-resistance',
    'pulmonary_vascular_resistance_not_measured': 'pulmonary-vascular-resistance-not-measured',
    'pulmonary_hypertension_catheter': 'pulmonary-hypertension-catheter',
    
    // Biomarkers
    'troponin_i': 'troponin-i',
    'troponin_t': 'troponin-t',
    'nt_probnp': 'nt-probnp',
    'bnp': 'bnp',
    'bnp_not_measured': 'bnp-not-measured',
    'ck_mb': 'ck-mb',
    'ck_mb_not_measured': 'ck-mb-not-measured',
    'myoglobin': 'myoglobin',
    'myoglobin_not_measured': 'myoglobin-not-measured',
    'ldh': 'ldh',
    'ldh_not_measured': 'ldh-not-measured',
    'crp': 'crp',
    'ddimer': 'ddimer',
    'homocysteine': 'homocysteine',
    'ldl': 'ldl',
    'hdl': 'hdl',
    'triglycerides': 'triglycerides',
    'hba1c': 'hba1c',
    'bun': 'bun',
    'creatinine': 'creatinine',
    'blood_ph': 'blood-ph',
    'ketones': 'ketones',
    'sodium': 'sodium',
    'potassium': 'potassium',
    'calcium': 'calcium',
    'calcium_not_assessed': 'calcium-not-assessed',
    'magnesium': 'magnesium',
    'magnesium_not_assessed': 'magnesium-not-assessed',
    'chloride': 'chloride',
    'chloride_not_assessed': 'chloride-not-assessed',
    'tsh': 'tsh',
    'tsh_not_assessed': 'tsh-not-assessed',
    'free_t3': 'free-t3',
    'free_t3_not_assessed': 'free-t3-not-assessed',
    'free_t4': 'free-t4',
    'free_t4_not_assessed': 'free-t4-not-assessed',
    'testosterone': 'testosterone',
    'testosterone_not_assessed': 'testosterone-not-assessed',
    'ferritin': 'ferritin',
    'transferrin_saturation': 'transferrin-saturation',
    'coronary_artery_calcium': 'coronary-artery-calcium',
    'periphral_artery': 'periphral-artery',
    'right_ankle_brachial': 'right-ankle-brachial',
    'right_ankle_brachial_not_assessed': 'right-ankle-brachial-not-assessed',
    'left_ankle_brachial': 'left-ankle-brachial',
    'left_ankle_brachial_not_assessed': 'left-ankle-brachial-not-assessed',
    
    // Disease Categories
    'aa_ad': 'aa-ad',
    'chd': 'chd',
    'endocarditis1': 'endocarditis1',
    'myocarditis1': 'myocarditis1',
    'pericarditis1': 'pericarditis1',
    'disease_present': 'disease-present',
    'disease_present_result': 'disease-present-result',
    'disease_present2': 'disease-present2',
    'disease_present2_result': 'disease-present2-result',
    'disease_present3': 'disease-present3',
    'disease_present3_result': 'disease-present3-result',
    'disease_present4': 'disease-present4',
    'disease_present4_result': 'disease-present4-result',
    
    // Auscultation
    'asymptomatic_valvular': 'asymptomatic-valvular',
    'murmur_present': 'murmur-present',
    's3': 's3',
    's4': 's4',
    
    // Cardiac Assessment - LV Size & Function Measurements
    'lv_size': 'lv-size',
    'lvedv': 'lvedv',
    'lvedv_not_assessed': 'lvedv-not-assessed',
    'lvesv': 'lvesv',
    'lvesv_not_assessed': 'lvesv-not-assessed',
    'lvef': 'lvef',
    'lvef_not_assessed': 'lvef-not-assessed',
    'fs': 'fs',
    'fs_not_assessed': 'fs-not-assessed',
    'lv_mass': 'lv-mass',
    'lv_mass_not_assessed': 'lv-mass-not-assessed',
    'lv_mass_index': 'lv-mass-index',
    'lv_mass_index_not_assessed': 'lv-mass-index-not-assessed',
    'gls': 'gls',
    'gls_not_assessed': 'gls-not-assessed',
    'cd_on_imaging': 'cd-on-imaging',
    'lv_hypertrophy': 'lv-hypertrophy',
    'e_e_prime_ratio': 'e-e-prime-ratio',
    'ejection_time': 'ejection-time',
    'ejection_time_not_assessed': 'ejection-time-not-assessed',
    'cardiac_output': 'cardiac-output',
    'cardiac_output_not_assessed': 'cardiac-output-not-assessed',
    
    // Cardiac Assessment - RV & LA Size & Function
    'rv_size': 'rv-size',
    'rv_diameter': 'rv-diameter',
    'rv_diameter_not_assessed': 'rv-diameter-not-assessed',
    'rv_wall_thickness': 'rv-wall-thickness',
    'rv_wall_thickness_not_assessed': 'rv-wall-thickness-not-assessed',
    'rv_ejection_fraction': 'rv-ejection-fraction',
    'rv_ejection_fraction_not_assessed': 'rv-ejection-fraction-not-assessed',
    'rv_tapse': 'rv-tapse',
    'rv_tapse_not_assessed': 'rv-tapse-not-assessed',
    'left_atrial_volume': 'left-atrial-volume',
    'left_atrial_volume_not_assessed': 'left-atrial-volume-not-assessed',
    'aortic_root_diameter': 'aortic-root-diameter',
    'aortic_root_diameter_not_assessed': 'aortic-root-diameter-not-assessed',
    'ascending_aorta_diameter': 'ascending-aorta-diameter',
    'ascending_aorta_diameter_not_assessed': 'ascending-aorta-diameter-not-assessed',
    'ivc_diameter': 'ivc-diameter',
    'ivc_diameter_not_assessed': 'ivc-diameter-not-assessed',
    'ivc_collapsibility_index': 'ivc-collapsibility-index',
    'ivc_collapsibility_index_not_assessed': 'ivc-collapsibility-index-not-assessed',
    
    // Cardiac Assessment - Valvular & Wall Motion
    'wall_motion_abnormalities': 'wall-motion-abnormalities',
    'valvular_function': 'valvular-function',
    'valve_area': 'valve-area',
    'pressure_peak': 'pressure-peak',
    'pressure_mean': 'pressure-mean',
    'pressure_gradients_not_assessed': 'pressure-gradients-not-assessed',
    'regurgitation_volume': 'regurgitation-volume',
    'regurgitation_volume_not_assessed': 'regurgitation-volume-not-assessed',
    'regurgitation_fraction': 'regurgitation-fraction',
    'regurgitation_fraction_not_assessed': 'regurgitation-fraction-not-assessed',
    'valvular_disease_severity': 'valvular-disease-severity',
    
    'summary': 'summary',
    'summary1': 'summary1'
  };
  
  // Populate P1 form data (both known fields and additional fields)
  let fieldsUpdated = 0;
  let fieldsNotFound = 0;
  
  Object.keys(p1Mapping).forEach(fieldName => {
    const value = allP1Data[fieldName]; // Use merged data that includes additional_fields
    const elementIds = p1Mapping[fieldName];
    
    // Handle both single element IDs and arrays of element IDs
    const idsToUpdate = Array.isArray(elementIds) ? elementIds : [elementIds];
    
    idsToUpdate.forEach(elementId => {
      const element = document.getElementById(elementId);
      
      if (element) {
        if (value === null || value === undefined) {
          // For null/undefined values, show "-"
          element.textContent = '-';
          console.log(`Updated #${elementId} with "-" (was null/undefined)`);
        } else if (value === 'n.A') {
          // For "n.A" values, show as "-"
          element.textContent = '-';
          console.log(`Updated #${elementId} with "-" (was n.A)`);
        } else {
          // For actual values, show them (with date formatting if applicable)
          element.textContent = formatDateValue(value);
          console.log(`Updated #${elementId} with value: ${formatDateValue(value)}`);
        }
        fieldsUpdated++;
      } else {
        console.log(`Element #${elementId} not found for field ${fieldName}`);
        fieldsNotFound++;
      }
    });
  });
  
  console.log(`P1 Form Display Summary: ${fieldsUpdated} fields updated, ${fieldsNotFound} elements not found`);
  
  // Handle any additional fields that don't have specific mappings
  if (latestP1.additional_fields) {
    Object.keys(latestP1.additional_fields).forEach(fieldName => {
      // Skip fields that are already handled by p1Mapping
      if (!p1Mapping[fieldName]) {
        // Try to find an element with the same ID as the field name
        const element = document.getElementById(fieldName.replace(/_/g, '-'));
        if (element) {
          const value = latestP1.additional_fields[fieldName];
          if (value === null || value === undefined || value === 'n.A') {
            element.textContent = '-';
          } else {
            element.textContent = value;
          }
          console.log(`Updated additional field #${fieldName.replace(/_/g, '-')} with value: ${value}`);
        }
      }
    });
  }
  
  console.log('Latest P1 form displayed:', latestP1);
}



function toggleYearDisplay(baseId) {
    const valueElement = document.getElementById(baseId + "-display");
    const yearContainer = document.getElementById(baseId + "-year-display-container");

    if (!valueElement || !yearContainer) return;

    const value = valueElement.textContent.trim().toLowerCase();

    if (value === "yes") {
        yearContainer.style.display = "block";
    } else {
        yearContainer.style.display = "none";
    }
}

document.addEventListener("DOMContentLoaded", function () {

    const procedures = [
      
        "septal-myectomy",

        "cardiac-pacemaker",
        "cardiac-icd",
        "cardiac-crt",
        "cardiac-catheter-ablation",
        "cardiac-maze-procedure",

        "lvad-implementation",
        "heart-transplant",
        "pulmonary-thromboendarterectomy",

        "aortic-aneurysm",
        "thoracic-surgery",
        "abdominal-surgeries"
    ];

    procedures.forEach(id => toggleYearDisplay(id));

});
