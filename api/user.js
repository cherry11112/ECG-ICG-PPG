import { sql } from '@vercel/postgres'
import { ensureSchema } from './_db.js'
import { requireAuth } from './_auth.js'

export default async function handler(req, res) {
  try {
    // Ensure tables exist on cold starts / first deploys
    await ensureSchema()

    // Check if using Bearer token (for getting current authenticated user)
    const auth = requireAuth(req);
    if (auth) {
      // Return current authenticated user
      const { rows } = await sql`
        select
          u.id,
          u.full_name,
          u.username,
          u.role,
          u.created_at
        from users u
        where u.id = ${auth.sub}
      `;
      return res.status(200).json(rows)
    }

    // Otherwise check for API key (admin access to list all users).
    // TODO(voice-agent): was gated on N8N_API_KEY when n8n used this route for admin
    // lookups. Renamed to ADMIN_API_KEY — set this env var in Vercel before deploying.
    const providedKey = req.headers['x-api-key']
    const expectedKey = process.env.ADMIN_API_KEY

    if (!expectedKey || providedKey !== expectedKey) {
      return res.status(401).json({ message: 'Unauthorized' })
    }

    // Return all users (admin access)
    const { rows } = await sql`
      select
        u.id,
        u.full_name,
        u.username,
        u.role,
        u.created_at,
        prfa.p1_reports,
        ffa.feedback_forms,
        fba.feedback_entries
      from users u
      /* All P1 reports for patient as array */
      left join lateral (
        select coalesce(json_agg(p1 order by p1.created_at desc), '[]'::json) as p1_reports
        from p1_report_form p1
        where p1.patient_id = u.id
      ) prfa on true
      /* All structured feedback_form entries for patient as array */
      left join lateral (
        select coalesce(json_agg(ff order by ff.created_at desc), '[]'::json) as feedback_forms
        from feedback_form ff
        where ff.patient_id = u.id
      ) ffa on true
      /* All feedback (json payload) entries for patient as array */
      left join lateral (
        select coalesce(json_agg(f order by f.created_at desc), '[]'::json) as feedback_entries
        from feedback f
        where f.user_id = u.id
      ) fba on true
      /* Only patients */
      where u.role = 'patient'
      order by u.created_at desc
    `;
    res.status(200).json(rows)
  } catch (err) {
    console.error('Error fetching users:', err)
    res.status(500).json({ message: 'Internal Server Error' })
  }
}
