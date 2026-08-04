// /api/config.js
// Serves public, non-secret runtime config to the browser (never API keys —
// only the voice-agent backend's base URL). Static HTML has no build step to
// inject env vars at build time, so this mirrors the existing api/* serverless
// function pattern to hand the value over at request time instead.
export default async function handler(req, res) {
  const backendUrl = process.env.VOICE_AGENT_BACKEND_URL || ''
  res.setHeader('Content-Type', 'application/javascript')
  res.setHeader('Cache-Control', 'public, max-age=60')
  res.status(200).send(`window.VOICE_AGENT_BACKEND_URL = ${JSON.stringify(backendUrl)};`)
}
