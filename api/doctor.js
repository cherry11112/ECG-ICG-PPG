import { ensureSchema, listPatients, insertDoctorReport } from './_db.js'
import { requireAuth } from './_auth.js'

export default async function handler(req, res) {
  const auth = requireAuth(req)
  if (!auth) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }
  await ensureSchema()
  if (req.method === 'GET') {
    if (auth.role !== 'doctor') {
      res.status(403).json({ error: 'Forbidden' })
      return
    }
    const patients = await listPatients()
    res.status(200).json({ patients })
    return
  }
  if (req.method === 'POST') {
    if (auth.role !== 'doctor') {
      res.status(403).json({ error: 'Forbidden' })
      return
    }
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = Buffer.concat(chunks).toString()
    const { patientId, sickStatus, notes, diagnosis } = JSON.parse(body || '{}')
    if (!patientId) {
      res.status(400).json({ error: 'Missing patientId' })
      return
    }
    const row = await insertDoctorReport({ patientId, doctorId: auth.sub, sickStatus, notes, diagnosis })
    res.status(200).json({ id: row.id })
    return
  }
  res.status(405).json({ error: 'Method Not Allowed' })
}


