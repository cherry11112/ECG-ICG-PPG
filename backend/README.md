# Voice agent backend (Pipecat + Claude)

Replaces the n8n workflows removed in Stage 1. This service is reached only via
the room URL/token handed back from `POST /connect` — the frontend (Stage 3)
never talks to Deepgram/Cartesia/AssemblyAI/Daily/Anthropic/Neon/R2 directly.

## Architecture

- **Transport:** Daily (`pipecat.transports.daily`)
- **STT:** Deepgram (primary) or AssemblyAI (fallback) — set via `STT_PROVIDER`
- **TTS:** Cartesia (primary) or Deepgram (fallback) — set via `TTS_PROVIDER`
- **LLM:** Gemini (`GoogleLLMService`, default) or Claude (`AnthropicLLMService`) —
  set via `LLM_PROVIDER`. Both are verified working (real API calls, both
  construct with all 4 tools registered) — switching is a one-line env var
  change, no code change. Note this is separate from the Node app's own
  Gemini+Claude dual-diagnostic feature (`api/diagnostic/[...slug].js`) — that
  already existed before this project and generates the AI diagnostic report;
  this `LLM_PROVIDER` setting only controls which model the *voice agent*
  itself reasons with.
- **Server:** FastAPI (`server.py`) exposes `POST /connect`, which creates a Daily
  room + token and spawns `bot.py` as a subprocess per session
- **Write path:** daily-feedback answers are saved by calling back into the
  existing Node/Vercel API's `tools/save-answer` and `tools/finalize-session`
  routes (`api/feedback/[...slug].js`) — not duplicated in Python

```
backend/
  config.py       env var loading + validation
  prompts.py      system prompt (3 modes) + 27-question map
  bot.py          pipeline construction, run per Daily session (subprocess)
  server.py       FastAPI /connect endpoint
  tools/
    neon.py       get_patient_context (Neon, parameterized queries)
    r2.py         get_biosignal_result (R2, summarizes before returning to Claude)
    feedback.py   save_feedback_answer / finalize_feedback_session (calls Node API)
  smoke_test.py   construction-only sanity check, no real credentials needed
  requirements.txt / runtime.txt / Procfile / .env.example
```

## ⚠️ Windows note

`daily-python` (Daily's C-extension SDK) ships Linux/macOS wheels only — there is
no Windows wheel. This means:

- `server.py` (the `/connect` endpoint) runs fine natively on Windows — it only
  makes REST calls to Daily to create a room/token, via `pipecat.runner.daily.configure()`.
- `bot.py` (which actually joins the Daily room) **cannot run natively on
  Windows**. Use WSL2 or Docker for local dev, or just deploy to Railway (Linux)
  and test end-to-end there.

Everything in this backend was verified against the actual installed
`pipecat-ai==1.5.0` package (class names/constructor args were introspected, not
assumed) on Python 3.12. Python 3.13/3.14 do **not** currently work — several of
pipecat's pinned sub-dependencies (numba/onnxruntime for the Silero VAD model)
don't have wheels for them yet. Use Python 3.12.

## Setup

```bash
cd backend
python3.12 -m venv .venv        # must be 3.12 — see note above
# Windows:  .venv\Scripts\activate
# Linux/macOS/WSL2: source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env            # fill in real values, see below
```

## Run locally

```bash
# Sanity check — no real credentials needed, doesn't touch Daily/Neon/R2:
python smoke_test.py

# Start the /connect server (works on Windows too):
python server.py
# -> POST http://localhost:7860/connect  {"patient_id": 1, "mode": "data_query"}
#    returns {"room_url", "token", "session_id"}

# The bot itself (needs Linux/WSL2/Docker — see Windows note above):
python bot.py --room-url <url> --token <token> --patient-id 1 --session-id s1 --mode data_query
```

## Env vars still needed from you

Already have (from Stage 0/2): `DEEPGRAM_API_KEY`, `CARTESIA_API_KEY`,
`ASSEMBLYAI_API_KEY`, `DAILY_API_KEY`.

Still need real values for:
- `ANTHROPIC_API_KEY` — Claude
- `DATABASE_URL` — your Neon connection string (same one Vercel uses)
- `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME` — R2 credentials with read (and, for the Python biosignal pipeline, write) access
- `APP_API_BASE_URL` — your deployed Vercel app URL (e.g. `https://your-app.vercel.app`), so `save_feedback_answer`/`finalize_feedback_session` can reach `api/feedback/[...slug].js`
- `FRONTEND_ORIGINS` — comma-separated exact origin(s) allowed to call `/connect` from a browser (CORS). Added in Stage 3 once the frontend started calling this service cross-origin. Defaults to `*` if unset — fine for local dev, set explicitly (e.g. `https://your-app.vercel.app`) in production.

See `.env.example` for the full list with defaults.

## R2 key convention — patient-scoped, no shared/global paths

`run_analysis.py` (root of the repo) writes one combined ECG+PPG+ICG result
object per patient run, and uploads it under each signal's own folder so a
lookup by `signal_type` finds a patient-scoped file:

```
data/{patient_id}/{SIGNAL}/processed_{signal_type}.json          (current)
data/{patient_id}/{SIGNAL}/history/{run_timestamp}.json          (archival, never overwritten)
images/{patient_id}/{filename}.png                                (all PNG/metadata output)
```

`SIGNAL` is the uppercased `signal_type` (`ECG`, `ICG`, `PPG`; `PCG` isn't
produced by any script yet). `tools/r2.py`'s `R2_KEY_TEMPLATE` only ever reads
the "current" file, and — same as before — never falls back to a shared/global
path, to avoid ever serving one patient's data to another. The JSON body also
has `patientId` set to that same id; the tool double-checks it and refuses to
serve a mismatch even if the key were somehow wrong.

If the pipeline's script (`run_analysis.py`) is missing `patient_id`, it now
refuses to process or upload anything rather than falling back to a shared
path — there is no `data/ecg_results.json` or `images/{filename}.png` global
location anymore.

**Field names/units the tool reads** (taken directly from the real
`data/ecg_results.json` schema — the pipeline should keep using these when it
starts writing per-patient/per-signal files):

| signal_type | reads from | notes |
|---|---|---|
| `ecg` | `metrics.ecg_heart_rate`, top-level `hr_min`/`hr_max`, `measurements.qrs_width_mean`/`qt_interval_mean`/`qtc_interval_mean`/`pr_interval_mean` (**seconds**, not ms), top-level `st_analysis` | |
| `ppg` | `metrics.ppg_heart_rate`, `metrics.systolic_bp_mean`, `metrics.diastolic_bp_mean` | |
| `icg` | `metrics.icg_heart_rate`, `metrics.icg_cardiac_output`, `metrics.icg_stroke_volume`, `metrics.pep`, `metrics.lvet` | |
| `pcg` | not produced by the pipeline yet | tool returns `ready: false` |

All four also read top-level `summary`, `rhythm`, `abnormalities`, and
`metadata.processingDate` (as `generated_at`). The raw `signals.*` waveform
arrays (33k+ points each in the real file) are never read into the summary —
only these scalar fields.

If the pipeline ends up using a different key layout, override it with the
`R2_KEY_TEMPLATE` env var (no code change needed) rather than editing call sites.

## Claude tools — signatures and sample output

### `get_patient_context(patient_id: int)` — Neon

Parameterized asyncpg queries against `users`, `feedback_form`, `report_form`,
`diagnostic_results`. No string interpolation of the patient_id into SQL.

**Verified against your real, live Neon database** (connected with the
credentials you shared and ran this against 5 real patient rows). This caught
a real bug: `schema.sql`'s `report_form` definition is stale — the deployed
table has 249 columns under different names (e.g. no `reporttype` column at
all). Fixed to query columns confirmed to actually exist:
`age, gender, bmi, smoking, diabetes, heart_failure, blood_pressure,
cholesterol, nyha, lvef`. `feedback_form` and `diagnostic_results` matched
`schema.sql` correctly and needed no changes.

Shape (field values below are illustrative, not real patient data):

```json
{
  "patient": { "id": 1, "full_name": "Jane Doe", "role": "patient" },
  "latest_feedback": {
    "created_at": "2026-07-09T08:00:00Z",
    "dyspnea": "No", "chest_pain": "No", "weight_kg": "71.2",
    "blood_pressure_systolic": 128, "blood_pressure_diastolic": 82,
    "fatigue_level": 3, "sleep_quality": 7, "free_comment": null
  },
  "latest_report": {
    "created_at": "2026-06-30T12:00:00Z",
    "age": 58, "gender": "F", "bmi": "26.1",
    "smoking": "No", "diabetes": "No", "heart_failure": "Yes",
    "blood_pressure": "Yes", "cholesterol": "No", "nyha": "I", "lvef": "55"
  },
  "latest_diagnostic": {
    "created_at": "2026-07-08T09:00:00Z",
    "risk_level": "Moderate", "risk_percentage": 34,
    "summary": "Stable, mild fluid retention trend over past week.",
    "has_feedback_data": true, "has_report_data": true, "has_ecg_data": true,
    "cloudflare_json_url": null
  }
}
```

### `get_biosignal_result(patient_id: int, signal_type: "ecg"|"ppg"|"icg"|"pcg")` — R2

Fetches the JSON result file from R2 and returns a numeric summary — never the
raw waveform/signal array — so Claude speaks concise findings instead of
reciting data. Field names/units below are exactly what the tool emits, taken
from a real production result object (see "R2 key convention" above) — note
intervals are in **seconds**, not milliseconds.

```json
{
  "ready": true,
  "signal_type": "ecg",
  "summary": "Cardiac Assessment: ECG shows HR 60 bpm with regular rhythm and no abnormalities.",
  "rhythm": "Regular",
  "abnormalities": [],
  "generated_at": "2026-04-05 21:00:47",
  "measurements": {
    "heart_rate_bpm": 60,
    "heart_rate_min_bpm": 56,
    "heart_rate_max_bpm": 72,
    "qrs_width_mean_s": 0.1,
    "qt_interval_mean_s": 0.4,
    "qtc_interval_mean_s": 0.41,
    "pr_interval_mean_s": 0.16,
    "st_analysis": "ST segment duration: 0.100 seconds"
  }
}
```

If the file doesn't exist yet: `{"ready": false, "signal_type": "ecg", "message": "No result file found yet."}`

### `save_feedback_answer(patient_id, session_id, question_id, answer_value)` / `finalize_feedback_session(patient_id, session_id)`

Thin wrappers around the existing Node endpoints — see `api/feedback/[...slug].js`
for the actual persistence logic and response shape (`{"success": true, ...}` or
`{"success": false, "reason": "incomplete", "missing": [...]}`).

## Access control on the Neon/R2 tools (Stage 4 security review)

`get_patient_context` and `get_biosignal_result` both take `patient_id` as an
argument, and Claude decides that argument's value from whatever's in the
session's context — so the real access-control boundary is **which
`patient_id` a Daily session is even allowed to be started for**, enforced once,
at `POST /connect`, in `authorize_connect_request()` (`server.py`):

- Requires `Authorization: Bearer <token>` — the same JWT `api/_auth.js` issues
  on login (verified with the shared `JWT_SECRET`, HS256). No token → `401`.
- If the token's role is `patient`: the requested `patient_id` must equal the
  token's own `sub` (user id). A patient token cannot start a session about any
  other patient → `403` otherwise.
- If the token's role is `doctor`: any `patient_id` is allowed. This
  intentionally mirrors the existing app-wide behavior — `GET /api/doctor`
  already returns *every* patient to *any* doctor, and there is no
  doctor-patient assignment table anywhere in this codebase. Restricting that
  further would be a product/schema change, out of scope for a deployment-
  readiness pass.
- A tampered or wrong-secret token → `401`.

Once a session passes this check, `patient_id` is fixed for that session's
lifetime (passed as a CLI arg to `bot.py`, not re-read from anything the client
sends afterward) — so nothing inside the voice conversation itself can pivot to
a different patient's data.

Additionally, `get_biosignal_result` independently checks that the R2 object's
own `patientId` field (once the pipeline starts writing it — see above) matches
the requested `patient_id`, and refuses to serve a mismatch, as defense in depth
against a pipeline bug writing one patient's file to another's key.

**CORS** (`FRONTEND_ORIGINS`) is a separate, weaker layer — it only stops
*browsers* from letting arbitrary web pages call `/connect`. It does nothing
against a direct `curl`/script call, which is exactly why the JWT check above
is the real gate, not CORS.

## Neon connection pooling (Railway)

`tools/neon.py`'s `asyncpg.create_pool()` is configured with
`statement_cache_size=0`. This is required, not optional, when `DATABASE_URL`
points at Neon's pooled endpoint (the `-pooler` hostname) — that's PgBouncer in
transaction-pooling mode, which can hand your next query to a different backend
connection than your last one. asyncpg's default server-side prepared-statement
cache assumes a stable backend connection and will intermittently throw
"prepared statement ... does not exist" under load without this. **Use the
pooled (`-pooler`) connection string** in `DATABASE_URL`, not Neon's direct
one — Railway can run multiple concurrent voice sessions, each holding a
connection, and the pooler is what keeps that from exhausting Neon's direct
connection limit.

## Deployment

Either platform runs Linux, so `daily-python` installs with no issue — the
Windows limitation described above only affects local dev on Windows.

### Render (used instead of Railway — Railway's free tier is a 5-day trial only)

`render.yaml` at the repo root is a Blueprint that declares the whole service
config explicitly (root directory, build/start commands, every env var name) —
this exists specifically so nothing has to be clicked through by hand in a
dashboard and silently misconfigured. That's literally what went wrong on
Railway: its "Root Directory" setting defaulted to the repo root instead of
`backend/`, so it ran the *root* `package.json`'s leftover `"start": "node"`
script (an idle Node REPL) instead of the Python app, for days, with no error —
just a hung connection, since nothing was ever listening on a port.

1. Render dashboard → **New** → **Blueprint** → point at the GitHub repo.
   Render reads `render.yaml` and creates the service pre-configured correctly.
2. Every var marked `sync: false` in `render.yaml` needs a real value filled in
   manually in Render's dashboard (Environment tab) — these are all secrets, so
   they're deliberately never written into the committed file. Use the real
   values from your local `backend/.env`.
3. Set `FRONTEND_ORIGINS` to your real Vercel URL, `APP_API_BASE_URL` to your
   real Vercel URL, `JWT_SECRET` to match Vercel's exactly.
4. Deploy. Confirm `GET https://<render-url>/health` returns `{"status":"ok"}`.
5. Set `VOICE_AGENT_BACKEND_URL` on the Vercel project to that Render URL
   (with `https://`! — see the note above about the scheme-less-URL bug).

Free tier note: Render's free web services **spin down after ~15 min of
inactivity** and take 30-60s to wake on the next request — the first person to
start a voice call after a quiet period will see a delay before `/connect`
responds. Not ideal for real patients long-term, but fine for testing/demo; a
paid Render plan removes this if it becomes a problem.

### Railway (alternative, if you have a paid plan)

1. Push `backend/` to a repo Railway can deploy from (or connect this whole
   monorepo and **set the service's Root Directory to `backend/` — do not skip
   this step**, see above for what happens if you do).
2. Railway auto-detects Python via `runtime.txt` (pins 3.12) and `Procfile`
   (`web: uvicorn server:app --host 0.0.0.0 --port $PORT`) — no extra build
   config needed, as long as Root Directory is actually set correctly.
3. Set every env var from `.env.example` in Railway's dashboard (Variables tab)
   with real values.
4. Set `FRONTEND_ORIGINS` and `APP_API_BASE_URL` to your real Vercel URL.
5. Deploy. Confirm `GET https://<railway-url>/health` returns `{"status":"ok"}`.
6. Set `VOICE_AGENT_BACKEND_URL` on the Vercel project to that Railway URL.

## Verified this session — what's real vs. still open

**Confirmed working, live, this session** (not just constructed in isolation):
- Anthropic: real API call, real response
- Daily, Deepgram, Cartesia, AssemblyAI: keys present, pipeline components
  construct successfully with them
- Neon: connected, queried 5 real patients, found and fixed a real schema bug
- R2: connected, wrote/read/deleted a real per-patient test fixture
- `APP_API_BASE_URL`: real write-verify-delete round trip against
  `session_answers` through the live Vercel deployment
- `/connect` auth gate: missing/bad-signature/wrong-secret tokens correctly
  `401`, cross-patient request correctly `403`, own-patient request passes
  through to Daily room creation (all covered in `smoke_test.py` now, not just
  ad hoc scripts)
- `statement_cache_size=0` fix: re-verified against the real Neon pooler
  connection after adding it — no regression

**Still open:**
- ⚠️ **The `DAILY_API_KEY` you have does not work** — `curl`-ing Daily's REST
  API with it returns `401 authentication-error`. It's prefixed `pk_...`, which
  isn't the shape of a Daily server-side API key (get the real one from
  dashboard.daily.co → Developers → API keys). Nothing else can be end-to-end
  tested until this is fixed.
- An actual full Daily voice round-trip (needs the real Daily key above, plus a
  Linux runtime — Railway, or WSL2/Docker locally)
- `run_analysis.py` now writes patient-scoped, per-signal files (see "R2 key
  convention" above) — `get_biosignal_result` returns real data once it's run
  for a patient; still needs an end-to-end run against a live bucket to confirm
- `JWT_SECRET` in your local `backend/.env` is a placeholder — must be set to
  the exact value configured on your Vercel project before deployed tokens will
  verify
