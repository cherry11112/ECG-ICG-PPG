import { sql } from '@vercel/postgres'

export default async function handler(req, res) {
  try {
    const { rows } = await sql`select 1 as ok`;
    res.status(200).json({ status: 'ok', db: rows[0] && rows[0].ok === 1 })
  } catch (err) {
    res.status(500).json({ status: 'error', message: err?.message || 'DB error' })
  }
}


