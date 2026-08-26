# Voice Agent Workflow

How a patient's "Daily Feedback" (or doctor's "Ask about this patient") voice
call actually works end to end — every service involved, why it's there, and
how the pieces are wired together. For API-level detail (tool signatures,
sample payloads, deployment steps) see [`README.md`](README.md) in this same
folder; this document is the architecture walkthrough.

## The stack, at a glance

| Layer | Technology | Role |
|---|---|---|
| Frontend | `patient1.html` / `P1report.html` + `dist/js/voice-agent.js` | Mic capture, joins the call, plays the bot's voice |
| Call transport | **Daily.co** (WebRTC) | Carries audio between the browser and the bot in real time |
| Voice activity detection | **Silero VAD** | Detects when someone is speaking, in-process (no external API) |
| Speech-to-text | **Deepgram** (primary) / AssemblyAI (fallback) | Converts the patient's speech to text |
| LLM / conversation brain | **Claude** (Anthropic, primary) / Gemini (fallback) | Decides what to say, drives the conversation, calls tools |
| Text-to-speech | **Cartesia** (primary) / Deepgram (fallback) | Converts the bot's reply text to spoken audio |
| Pipeline framework | **Pipecat** (`pipecat-ai` 1.5.0) | Wires VAD → STT → LLM → TTS together as a streaming pipeline |
| Session server | **FastAPI** (`server.py`) | Auth, creates the Daily room, spawns the bot process |
| Structured data | **Neon** (Postgres) | Users, daily feedback answers, patient profile notes, diagnostics |
| Biosignal storage | **Cloudflare R2** | ECG/ICG/PPG results and images, per-patient |
| App backend / API | **Vercel** (`api/*.js`) | Auth (JWT), the actual database writes the voice agent's tools call into |
| Hosting for the above | **AWS EC2** (Ubuntu) | Runs `server.py` and every `bot.py` session |
| Reverse proxy + TLS | **Caddy** | Terminates HTTPS, forwards to the FastAPI app on `localhost:8000` |
| Public hostname | **DuckDNS** (`ecgbackend.duckdns.org`) | Stable hostname pointing at the EC2 box's IP |

## Life of one voice session

1. **Patient clicks a voice button** on `patient1.html` ("Daily Feedback" or
   "Chat") or a doctor clicks it on `P1report.html`.
2. The page already loaded `window.VOICE_AGENT_BACKEND_URL` from
   `/api/config.js` — a tiny Vercel function that hands back the
   `VOICE_AGENT_BACKEND_URL` env var (`https://ecgbackend.duckdns.org`) as a
   JS assignment. Static HTML has no build step to bake env vars in at build
   time, so this is how the browser learns where the voice backend lives.
3. `dist/js/voice-agent.js`'s `createVoiceSession()` calls
   `PipecatClient.startBotAndConnect()`, which does:
   ```
   POST https://ecgbackend.duckdns.org/connect
   Authorization: Bearer <the user's login JWT>
   { patient_id, mode, session_id }
   ```
4. That request hits **Caddy** on the EC2 box first — Caddy owns port 443,
   handles the TLS certificate (auto-provisioned via Let's Encrypt for the
   DuckDNS hostname) and reverse-proxies to `localhost:8000`, where the
   FastAPI app is listening.
5. `server.py`'s `/connect` handler (`authorize_connect_request`) verifies the
   JWT against `JWT_SECRET` — the **same secret `api/_auth.js` on Vercel signs
   with** — and checks the caller is allowed to start a session about that
   `patient_id` (a patient token can only be about themselves; a doctor token
   can be about anyone).
6. It then calls **Daily's REST API** to create a Daily video/audio room and a
   meeting token (this part needs no special Python package, just an HTTP
   call via `pipecat.runner.daily.configure()`).
7. It spawns **`bot.py` as a subprocess** — one fresh Python process per
   session — passing the room URL, token, `patient_id`, `session_id`, and
   `mode` as CLI args, and immediately returns `{room_url, token, session_id}`
   to the browser.
8. The browser's `PipecatClient` (via `DailyTransport`) joins the Daily room
   directly with its own Daily client SDK. From here, **audio flows over
   WebRTC through Daily's infrastructure** — not back through the EC2 box.
9. The spawned `bot.py` process *also* joins that same Daily room, as a
   participant named "Cardiac Assistant", and builds its Pipecat pipeline:

   ```
   Daily audio in
       → VAD (Silero)                      — detects speech
       → STT (Deepgram / AssemblyAI)       — speech → text
       → LLM user-context aggregator       — assembles the user's turn
       → LLM (Claude / Gemini)             — decides the reply, calls tools
       → TTS (Cartesia / Deepgram)         — text → speech
       → Daily audio out
   ```

10. As soon as the browser's participant joins (`on_client_connected`), the
    bot queues an `LLMRunFrame` so **it speaks first**, without waiting to be
    spoken to — see [Turn-taking](#turn-taking-and-interruptions) below for
    how that's enforced.
11. The LLM's system prompt (built by `prompts.py` for whichever `mode` was
    requested) tells it what to say and which tools it's allowed to call —
    see [Modes](#the-three-modes) and [Tools](#tools-the-llm-can-call).
12. The bot's reply streams to TTS and back out over Daily to the browser's
    `<audio>` element in near-real time (word by word, not waiting for the
    full reply).
13. When the call ends (participant leaves, or the patient hangs up),
    `on_client_disconnected` cancels the pipeline worker and the `bot.py`
    process exits. Nothing about that session persists in the Python process
    — everything worth keeping was already written to Neon/R2 as it happened.

## The three modes

`bot.py --mode` is one of:

- **`daily_feedback`** — the structured check-in. Two phases, always in
  order: 15-20 AI-generated general/profile-building questions (background,
  medical history, family history, lifestyle — saved via `save_profile_note`,
  accumulating across every session so the profile grows over time and the
  AI avoids repeating what it already knows), then the fixed 27-question
  daily symptom questionnaire (saved via `save_feedback_answer`, one row per
  day). Wired to the "Daily Feedback" button on `patient1.html`.
- **`general_chat`** — open-ended conversation, grounded in the patient's
  real data via tools rather than speculation. Wired to the voice button on
  `patient1.html` and to `P1report.html` (doctor's view).
- **`data_query`** — implemented in `prompts.py`/`bot.py` for asking about
  existing feedback/report/biosignal data specifically, but **not currently
  wired to any UI button** (both current UIs use `general_chat`, which
  already covers the same tools). Available for a future UI hook without any
  backend change.

## Tools the LLM can call

Two different data paths, depending on whether the tool reads or writes:

**Reads — straight to the data store, no Vercel round-trip:**
- `get_patient_context` (`tools/neon.py`) — queries Neon (Postgres) directly
  with `asyncpg` for the patient's latest feedback, report, diagnostic
  status, uploaded documents, and accumulated profile notes.
- `get_biosignal_result` (`tools/r2.py`) — fetches a patient+signal-scoped
  JSON object from Cloudflare R2 (`data/{patient_id}/{SIGNAL}/processed_*.json`,
  written by `run_analysis.py`) via `boto3`, and returns a numeric summary
  (never raw waveform data) to the LLM.

**Writes — call back into the existing Node/Vercel API, so there's one source
of truth for the write path instead of duplicating SQL in Python:**
- `save_feedback_answer`, `save_followup_answer` — one of the 27 daily
  questions, or a follow-up note on one → `POST /api/feedback/tools/*`.
- `save_profile_note` — one of the 15-20 general questions →
  `POST /api/feedback/tools/save-profile-note`.
- `finalize_feedback_session` — wraps up a daily-feedback session.

`patient_id` and `session_id` for every tool call come from the session's
`app_resources` (set once at `/connect` time from the JWT-verified value) —
**never** from the LLM's own tool-call arguments, so a hallucinated or
manipulated `patient_id` can't leak or write another patient's data.

## Turn-taking and interruptions

Two settings on the LLM's user-context aggregator (`bot.py`,
`_build_llm_and_context`) control how the bot handles the patient's mic:

- **`MuteUntilFirstBotCompleteUserMuteStrategy`** — every user audio/speech
  frame is dropped from the moment the call connects until the bot finishes
  its very first turn (greeting + first question). The system does not
  "hear" or react to anything said before that.
- **`enable_interruptions=False`** on both the VAD-based and
  transcription-based turn-start strategies — for the rest of the session,
  the patient talking never cuts off audio the bot is currently playing (no
  barge-in). Their speech is still transcribed and answered, just after the
  bot finishes its current turn, not mid-sentence.

## Auth and security model

- Login issues a JWT (`api/_auth.js`, HS256, `JWT_SECRET`) with `sub` (user
  id) and `role` (`patient` | `doctor`).
- The **same `JWT_SECRET`** is configured on both Vercel and the EC2 box's
  `backend/.env` — this is what lets `server.py` verify a token Vercel
  issued, without the two ever talking to each other for auth.
- `/connect` is the only access-control checkpoint: once a session starts for
  a given `patient_id`, every tool call for that session's lifetime is
  scoped to that same `patient_id` via `app_resources`, not re-checked per
  call.
- No API keys (Daily, Deepgram, Cartesia, Anthropic, R2, database
  credentials) ever reach the browser — the browser only ever holds a Daily
  room URL + short-lived meeting token, both already scoped to one room.

## Deployment topology (AWS EC2)

Live deployment, as configured on the box (`51.21.66.5`, `ecgbackend.duckdns.org`):

```
Internet
  → DuckDNS (ecgbackend.duckdns.org → EC2 IP)
  → Caddy :443 (auto TLS, reverse_proxy localhost:8000)
  → uvicorn server:app :8000  (systemd service: ecg-backend.service)
      → spawns: python bot.py ...   (one subprocess per active call)
```

- **systemd unit** (`/etc/systemd/system/ecg-backend.service`): runs
  `venv/bin/python3 -m uvicorn server:app --host 0.0.0.0 --port 8000` from
  `~/ECG-ICG-PPG/backend`, loads `backend/.env` as its environment,
  `Restart=always`.
- **Caddy** (`/etc/caddy/Caddyfile`):
  ```
  ecgbackend.duckdns.org {
      reverse_proxy localhost:8000
  }
  ```
  Caddy handles certificate issuance/renewal automatically — nothing in this
  repo manages TLS certs directly.
- **DuckDNS**: a free dynamic-DNS hostname pointed at the box's IP, so the
  frontend (and Caddy's cert) has a stable domain name instead of a raw IP.
  There's no auto-updater running on the box — the box's IP hasn't needed
  updating since it was pointed at DuckDNS, so it was set once, manually.
- **Why EC2 and not Railway/Render** (`Procfile`/`runtime.txt` in this
  folder): those files support deploying this same backend to Railway or
  Render instead, documented as options in `README.md`. The box actually
  running today uses systemd + Caddy directly on EC2 rather than either of
  those platforms.
- **Why not Windows**: `bot.py` needs the `daily-python` package to join a
  Daily room, which only ships Linux/macOS wheels. `server.py` (the
  `/connect` endpoint) runs fine anywhere, including native Windows — it's
  only the actual bot process that requires Linux, which is what EC2
  (Ubuntu) provides.

### Redeploying a backend change

```bash
ssh -i <key.pem> ubuntu@<ec2-ip>
cd ECG-ICG-PPG
git pull
sudo systemctl restart ecg-backend.service
curl -s http://localhost:8000/health   # expect {"status":"ok"}
```

`server.py` spawns a brand-new `python bot.py` subprocess per call, reading
`prompts.py`/`bot.py`/`tools/*.py` fresh from disk each time — so a restart
of `ecg-backend.service` isn't strictly required for changes to those files
to take effect on the *next* call, but restarting guarantees a clean state
and is the safe default after any pull.

Vercel (`api/*.js`, the frontend HTML/JS) auto-deploys on push — no manual
step needed there.

## Environment variables (`backend/.env` on EC2)

| Variable | Purpose |
|---|---|
| `LLM_PROVIDER` | `claude` (default) or `gemini` |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | Claude |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | Gemini (only required if `LLM_PROVIDER=gemini`) |
| `STT_PROVIDER` | `deepgram` (default) or `assemblyai` |
| `DEEPGRAM_API_KEY` | Deepgram STT (and TTS fallback) |
| `ASSEMBLYAI_API_KEY` | AssemblyAI STT (only if `STT_PROVIDER=assemblyai`) |
| `TTS_PROVIDER` | `cartesia` (default) or `deepgram` |
| `CARTESIA_API_KEY`, `CARTESIA_VOICE_ID` | Cartesia TTS |
| `DEEPGRAM_TTS_VOICE` | Deepgram TTS voice (only if `TTS_PROVIDER=deepgram`) |
| `DAILY_API_KEY`, `DAILY_API_URL` | Daily room/token creation |
| `DATABASE_URL` | Neon Postgres (pooled connection string) |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME` | Cloudflare R2 |
| `APP_API_BASE_URL` | The Vercel app's base URL — where the write-side tools POST to |
| `APP_INTERNAL_API_KEY` | Optional; sent as `x-internal-api-key` (not yet enforced Node-side) |
| `JWT_SECRET` | Must match Vercel's exactly |
| `FRONTEND_ORIGINS` | CORS allow-list for browser calls to `/connect` |
| `PORT` | Defaults to `7860` locally; EC2's systemd unit pins `8000` explicitly |

On Vercel: `VOICE_AGENT_BACKEND_URL` must be set to
`https://ecgbackend.duckdns.org` for `/api/config.js` to hand the frontend
the right backend address.

## Troubleshooting

- **Service status / recent logs**:
  `sudo systemctl status ecg-backend.service` /
  `sudo journalctl -u ecg-backend.service -n 200`
- **Health check**: `curl https://ecgbackend.duckdns.org/health` (or
  `localhost:8000/health` on the box) → `{"status":"ok"}`
- **A specific call misbehaved**: `journalctl` timestamps line up with when
  the call happened; each `bot.py` subprocess logs its own patient/session
  IDs and every tool call it makes (`pipecat.services.llm_service` DEBUG
  lines show function-call name + arguments).
- **"Voice agent is not configured yet"** in the browser: `VOICE_AGENT_BACKEND_URL`
  isn't set (or is unset) on Vercel — check `/api/config.js`'s output.
- **Bot never speaks**: check `DAILY_API_KEY` is a real server-side key (not
  a client key) and that the EC2 box can reach `api.daily.co` outbound.
