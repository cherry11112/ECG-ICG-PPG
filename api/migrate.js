import { ensureSchema } from './_db.js'
import { requireAuth } from './_auth.js'

export default async function handler(req, res) {
  try {
    const auth = requireAuth(req)
    if (!auth) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    
    if (auth.role !== 'doctor') {
      res.status(403).json({ error: 'Only doctors can run migrations' })
      return
    }

    console.log('Manual migration triggered by:', auth.username)
    await ensureSchema()
    
    res.status(200).json({ 
      success: true, 
      message: 'Migration completed successfully',
      timestamp: new Date().toISOString()
    })
  } catch (error) {
    console.error('Migration error:', error);
    res.status(500).json({ 
      error: 'Migration failed: ' + error.message 
    });
  }
}
