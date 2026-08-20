import {
  ensureSchema,
  insertFeedbackForm,
  getFeedbackFormByPatient,
  hasFeedbackToday,
  updateFeedbackAnswer,   // immediate, field-specific write into feedback_form
  saveFollowupAnswer,     // append an AI follow-up answer into feedback_form.<column>_free_text
  saveSessionAnswer,      // save to session_answers table (session-progress audit trail)
  getSessionAnswers,      // retrieve session answers
  isSessionComplete,      // check if all 27 questions answered
  finalizeSessionAnswers, // clean up session_answers and report completion status
  getPatientHealthData,   // fetch patient data for general chat context
  QUESTION_ID_MAP,
} from '../_db.js';
import { requireAuth } from '../_auth.js';
// TODO(voice-agent): n8n used to be triggered here to generate diagnostics after
// finalize-session/feedback submit. Replace with a call into the Pipecat/Claude
// voice agent pipeline (or a direct trigger of the diagnostic generation step).

export default async function handler(req, res) {
  await ensureSchema();

  // Parse path more robustly - try multiple methods
  let pathString = '';
  
  // Method 1: Try slug parameter (n8n dynamic routes)
  if (req.query.slug) {
    const slug = req.query.slug;
    pathString = Array.isArray(slug) ? slug.join('/') : slug;
  }
  
  // Method 2: Try from URL (direct access)
  if (!pathString && req.url) {
    const urlPath = req.url.split('?')[0]; // Remove query string
    // Try to find /api/feedback/ in the URL
    const feedbackIndex = urlPath.indexOf('/api/feedback/');
    if (feedbackIndex !== -1) {
      pathString = urlPath.substring(feedbackIndex + 14); // 14 = "/api/feedback/".length
    } else {
      // If /api/feedback/ not found, assume it's relative to /feedback/
      const parts = urlPath.split('/');
      // Find where 'feedback' is and get everything after it
      const feedbackIdx = parts.indexOf('feedback');
      if (feedbackIdx !== -1) {
        pathString = parts.slice(feedbackIdx + 1).join('/');
      }
    }
  }

  console.log('[feedback handler] URL:', req.url, 'slug:', req.query.slug, 'pathString:', pathString, 'method:', req.method);

  // ========== VOICE AGENT ENDPOINTS ==========

  if (pathString === 'check-today' && req.method === 'GET') {
    console.log('[check-today] Handler reached');
    try {
      const patientId = req.query.patient_id;
      if (!patientId) {
        return res.status(400).json({ error: 'patient_id is required' });
      }
      const hasSubmitted = await hasFeedbackToday(parseInt(patientId));
      return res.status(200).json({
        has_submitted_today: hasSubmitted,
        patient_id: patientId,
      });
    } catch (err) {
      console.error('[check-today]', err);
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  }

  if (pathString === 'patient-data' && req.method === 'GET') {
    console.log('[patient-data] Handler reached');
    try {
      const patientId = req.query.patient_id;
      if (!patientId) {
        return res.status(400).json({ error: 'patient_id is required' });
      }
      
      const patientData = await getPatientHealthData(parseInt(patientId));
      return res.status(200).json(patientData);
    } catch (err) {
      console.error('[patient-data]', err);
      return res.status(500).json({ error: 'Internal Server Error', message: err.message });
    }
  }

  if (pathString === 'tools/save-answer' && req.method === 'POST') {
    try {
      const payload = await parseBody(req, res);
      if (!payload) return;

      const { session_id, patient_id, question_id, raw_text } = payload;
      // Accept either answer_value or extracted_value (AI-parsed); fall back to raw_text
      const answer_value = payload.extracted_value ?? payload.answer_value ?? raw_text ?? null;

      if (!session_id || !patient_id || !question_id || answer_value === undefined) {
        return res.status(400).json({
          error: 'Missing required fields',
          required: ['session_id', 'patient_id', 'question_id', 'answer_value'],
          received: Object.keys(payload),
        });
      }

      if (!QUESTION_ID_MAP[question_id]) {
        return res.status(400).json({
          error: `Invalid question_id: "${question_id}"`,
          valid_question_ids: Object.keys(QUESTION_ID_MAP),
        });
      }

      // Track progress in session_answers (audit trail / completeness check) AND
      // write the answer straight into today's feedback_form row immediately —
      // the patient should not have to finish all 27 questions for this answer
      // to be persisted.
      const [sessionResult, formResult] = await Promise.all([
        saveSessionAnswer(parseInt(patient_id), session_id, question_id, answer_value),
        updateFeedbackAnswer(parseInt(patient_id), question_id, answer_value, session_id),
      ]);

      console.log(`[tools/save-answer] patient:${patient_id} q:${question_id} val:${answer_value} (session:${session_id})`);

      return res.status(200).json({
        success: true,
        message: 'Answer saved',
        session_id,
        patient_id,
        question_id,
        answer_value,
        raw_text: raw_text || null,
        saved_to_session: true,
        saved_to_feedback_form: true,
        column: formResult.column,
        session: sessionResult,
      });
    } catch (err) {
      console.error('[tools/save-answer]', err);
      return res.status(500).json({ error: err.message || 'Internal Server Error' });
    }
  }

  if (pathString === 'tools/save-followup-answer' && req.method === 'POST') {
    try {
      const payload = await parseBody(req, res);
      if (!payload) return;

      const { session_id, patient_id, question_id, question_context, answer_text } = payload;

      if (!session_id || !patient_id || !question_id || !answer_text) {
        return res.status(400).json({
          error: 'Missing required fields',
          required: ['session_id', 'patient_id', 'question_id', 'answer_text'],
          received: Object.keys(payload),
        });
      }

      if (!QUESTION_ID_MAP[question_id]) {
        return res.status(400).json({
          error: `Invalid question_id: "${question_id}"`,
          valid_question_ids: Object.keys(QUESTION_ID_MAP),
        });
      }

      const result = await saveFollowupAnswer(
        parseInt(patient_id),
        question_id,
        question_context || null,
        answer_text,
        session_id
      );

      console.log(`[tools/save-followup-answer] patient:${patient_id} q:${question_id} (session:${session_id}) context:"${question_context || ''}"`);

      return res.status(200).json({
        success: true,
        message: `Follow-up answer appended to ${result.column}`,
        session_id,
        patient_id,
        question_id,
        question_context: question_context || null,
        answer_text,
        ...result,
      });
    } catch (err) {
      console.error('[tools/save-followup-answer]', err);
      return res.status(500).json({ error: err.message || 'Internal Server Error' });
    }
  }

  if (pathString === 'tools/finalize-session' && req.method === 'POST') {
    try {
      const payload = await parseBody(req, res);
      if (!payload) return;

      const { session_id, patient_id } = payload;

      if (!session_id || !patient_id) {
        return res.status(400).json({
          error: 'Missing required fields',
          required: ['session_id', 'patient_id'],
        });
      }

      console.log(`[tools/finalize-session] Finalizing session:${session_id} patient:${patient_id}`);

      // Every answer was already written to feedback_form as it was collected, so
      // finalizing no longer gates on completeness — it just reports how many of
      // the 27 questions were answered and clears the session_answers staging rows.
      // Whatever the patient answered (even if they stopped early) is already saved.
      const result = await finalizeSessionAnswers(parseInt(patient_id), session_id);

      // TODO(voice-agent): n8n diagnostic-generation trigger removed. Re-wire this
      // to whatever replaces it in Stage 2+ (Claude tool-calling / direct trigger).

      return res.status(200).json({
        success: true,
        message: result.complete
          ? 'All 27 feedback answers collected and saved'
          : `Session ended with ${result.answers_collected}/27 answers — all provided answers are saved`,
        session_id,
        patient_id,
        completed_at: new Date().toISOString(),
        status: result.complete ? 'completed' : 'partial',
        ...result,
      });
    } catch (err) {
      console.error('[tools/finalize-session]', err);
      return res.status(500).json({ error: err.message || 'Internal Server Error' });
    }
  }

  if (pathString === 'save-answer' && req.method === 'POST') {
    try {
      const payload = await parseBody(req, res);
      if (!payload) return;

      const { patient_id, session_id, question_id } = payload;
      const answer = payload.answer_value ?? payload.answer;

      if (!patient_id || !session_id || !question_id || answer === undefined) {
        return res.status(400).json({
          error: 'Missing required fields: patient_id, session_id, question_id, answer',
        });
      }

      if (!QUESTION_ID_MAP[question_id]) {
        return res.status(400).json({
          error: `Invalid question_id: "${question_id}"`,
          valid_question_ids: Object.keys(QUESTION_ID_MAP),
        });
      }

      const result = await updateFeedbackAnswer(
        parseInt(patient_id),
        question_id,
        answer,
        session_id
      );

      return res.status(200).json({
        success: true,
        message: 'Answer saved successfully',
        session_id,
        patient_id,
        question_id,
        answer,
        ...result,
      });
    } catch (err) {
      console.error('[save-answer]', err);
      return res.status(500).json({ error: err.message || 'Internal Server Error' });
    }
  }

  if (pathString === 'complete-session' && req.method === 'POST') {
    try {
      const payload = await parseBody(req, res);
      if (!payload) return;

      const { session_id, patient_id, completed_at } = payload;

      if (!session_id || !patient_id) {
        return res.status(400).json({ error: 'Missing required fields: session_id, patient_id' });
      }

      return res.status(200).json({
        success: true,
        message: 'Session marked as complete',
        session_id,
        patient_id,
        completed_at: completed_at || new Date().toISOString(),
      });
    } catch (err) {
      console.error('[complete-session]', err);
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  }

  // BASE PATH ENDPOINTS (Manual Form Submission)

  if (pathString === '' || !pathString) {
    const auth = requireAuth(req);
    if (!auth) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!['GET', 'POST'].includes(req.method)) {
      return res.status(405).json({ error: 'Method Not Allowed' });
    }

    if (req.method === 'POST') {
      try {
        console.log('[POST /api/feedback] Auth user ID:', auth.sub);
        
        const alreadySubmitted = await hasFeedbackToday(auth.sub);
        if (alreadySubmitted) {
          return res.status(400).json({
            error: 'You have already submitted your daily feedback today. Please try again tomorrow.',
          });
        }

        const payload = await parseBody(req, res);
        if (!payload) return;

        console.log('[POST /api/feedback] Payload keys:', Object.keys(payload));

        const form = {};
        for (const k of Object.keys(payload)) {
          form[k.replace(/-/g, '_')] = payload[k];
        }

        console.log('[POST /api/feedback] Inserting form for patient:', auth.sub);
        const row = await insertFeedbackForm(auth.sub, form);
        console.log('[POST /api/feedback] Successfully inserted, row ID:', row.id);

        // TODO(voice-agent): n8n diagnostic-generation trigger removed. Re-wire this
        // to whatever replaces it in Stage 2+ (Claude tool-calling / direct trigger).

        return res.status(200).json({ id: row.id, message: 'Feedback submitted successfully' });
      } catch (err) {
        console.error('[POST /api/feedback] Caught error:', {
          message: err.message,
          code: err.code,
          detail: err.detail,
          constraint: err.constraint,
          sqlState: err.sqlState,
          toString: err.toString(),
          stack: err.stack
        });
        
        // Detect specific constraint violations
        let errorMsg = 'Internal Server Error';
        if (err.code === '23503') {
          errorMsg = 'User not found in database. Please log out and log in again.';
        } else if (err.code === '23505') {
          errorMsg = 'You have already submitted feedback today.';
        } else if (err.detail) {
          errorMsg = err.detail;
        }
        
        return res.status(500).json({ 
          error: errorMsg,
          database_code: err.code || 'unknown',
          details: err.message || 'Unknown error occurred'
        });
      }
    }

    if (req.method === 'GET') {
      try {
        const rows = await getFeedbackFormByPatient(auth.sub);
        const latestFeedback = rows && rows.length > 0 ? rows[0] : null;
        return res.status(200).json({ data: latestFeedback, items: rows });
      } catch (err) {
        console.error('[GET /api/feedback]', err);
        return res.status(500).json({ error: 'Internal Server Error' });
      }
    }
  }

  // UNKNOWN PATHS 
  return res.status(404).json({
    error: 'Endpoint not found',
    path: `/api/feedback/${pathString}`,
    method: req.method,
  });
}

// Helper function to parse request body
async function parseBody(req, res) {
  if (req.body && typeof req.body === 'object') {
    return req.body;
  }
  
  try {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString();
    if (!text) return {};
    return JSON.parse(text);
  } catch (err) {
    res.status(400).json({ error: 'Invalid JSON in request body' });
    return null;
  }
}


