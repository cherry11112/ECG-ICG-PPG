import { ensureSchema, getPatientReports, getFeedbackFormByPatient, getP1ReportFormByPatient, getPatientProfileNotes } from './_db.js'
import { requireAuth } from './_auth.js'

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method Not Allowed' })
    return
  }
  await ensureSchema()
  const auth = requireAuth(req)
  if (!auth) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  // allow doctor to view by patientId, otherwise patient can only view own
  const url = new URL(req.url, 'http://localhost')
  const patientIdParam = url.searchParams.get('patientId')
  let patientId = auth.sub
  if (patientIdParam && auth.role === 'doctor') {
    patientId = Number(patientIdParam)
  }

  const [doctorReports, patientFeedback, p1forms, profileNotes] = await Promise.all([
    getPatientReports(patientId),
    getFeedbackFormByPatient(patientId),
    getP1ReportFormByPatient(patientId),
    getPatientProfileNotes(patientId)
  ])
  res.status(200).json({ reports: doctorReports, feedback: patientFeedback, p1forms, profileNotes })
}


