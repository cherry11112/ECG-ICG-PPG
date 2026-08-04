# ecg-website

Setup

1) Create a Neon Postgres database and get the connection string.
   Example: postgres://USER:PASSWORD@HOST/DB?sslmode=require

2) In Vercel Project Settings → Environment Variables, add:
   - NEON_DATABASE_URL = your Neon connection string (use the pooled "-pooler" host)
   - JWT_SECRET = a long random string — the backend/ voice agent must be given
     this exact same value (as its own JWT_SECRET) so it can verify these tokens
   - OPENAI_API_KEY = your OpenAI API key (platform.openai.com)
   - OPENAI_TTS_MODEL (optional) = gpt-4o-mini-tts
   - OPENAI_TTS_VOICE (optional) = alloy
   - ADMIN_API_KEY = shared secret for GET /api/user admin access (was N8N_API_KEY)
   - VOICE_AGENT_BACKEND_URL = the deployed Railway URL of `backend/` (e.g.
     `https://your-app.up.railway.app`) — public, non-secret, served to the
     browser as-is via `api/config.js`. See `backend/README.md` for the backend's
     own (secret) env vars, which are set on Railway, not here.

3) Deploy to Vercel. API routes live under `api/*` and are exposed under `/api/*`.

Database

Use `schema.sql` to create required tables, or rely on on-demand `ensureSchema()` migrations.
- users: stores name, username, role, password_hash
- feedback: patient daily feedback JSON
- reports: doctor-managed patient report rows

API Endpoints

- POST /api/signup { fullName, username, password, role }
- POST /api/login { username, password }
- POST /api/feedback (Authorization: Bearer <token>)
- GET  /api/feedback (Authorization: Bearer <token>)
- POST /api/tts { text, voice?, model?, format? } → audio/mpeg

Frontend Integration

- `index.html`: login/signup and stores token/user in localStorage
- `doctor.html`: doctor dashboard
- `patient1.html`: daily feedback form and AI Voice Chat widget

AI Voice Chat (Patient Daily Feedback)

n8n has been fully removed. The voice widgets in `patient1.html` and
`P1report.html` now connect to a separate Pipecat voice agent backend (see
`backend/`) over Daily WebRTC:
- Browser mic audio streams to the backend; Deepgram/AssemblyAI (STT), Claude
  (reasoning + tool-calling into Neon/R2), and Cartesia/Deepgram (TTS) all run
  server-side there — no browser SpeechRecognition, no `/api/tts` call from
  this widget anymore (the standalone `/api/tts` route itself is unchanged and
  still used elsewhere).
- The widget calls the backend's `/connect` endpoint (via
  `VOICE_AGENT_BACKEND_URL`), authenticated with the same JWT this app already
  issues on login — see `backend/README.md` for the full architecture.

Notes
- No client secrets are exposed; keys are server-side (Vercel functions and the
  separate Railway-hosted voice backend).
- Change voice by passing `voiceId` in the `/api/tts` body (used elsewhere in
  the app, unrelated to the voice agent's own Cartesia/Deepgram TTS).