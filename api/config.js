// /api/config.js
// Serves public, non-secret runtime config to the browser (never API keys —
// only the voice-agent backend's base URL). Static HTML has no build step to
// inject env vars at build time, so this mirrors the existing api/* serverless
// function pattern to hand the value over at request time instead.
export default async function handler(req, res) {
  let backendUrl = (process.env.VOICE_AGENT_BACKEND_URL || '').trim()
  // Guard against the easy-to-make mistake of pasting the bare Railway host
  // without a scheme (e.g. "your-app.up.railway.app" instead of
  // "https://your-app.up.railway.app") — without this, the browser resolves
  // it as a relative path against the Vercel domain itself instead of an
  // absolute URL, and every request silently 404s against the wrong host.
  if (backendUrl && !/^https?:\/\//i.test(backendUrl)) {
    backendUrl = `https://${backendUrl}`
  }
  res.setHeader('Content-Type', 'application/javascript')
  res.setHeader('Cache-Control', 'public, max-age=60')
  res.status(200).send(`window.VOICE_AGENT_BACKEND_URL = ${JSON.stringify(backendUrl)};`)
}
