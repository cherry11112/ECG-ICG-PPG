"""Environment/config loading for the Pipecat voice agent backend.

All secrets are read from process env only — nothing here is safe to expose to a
browser. The Node/Vercel API (api/*) remains the only thing the frontend talks to
directly for auth; this service is reached only via the room URL + token handed
back from POST /connect.
"""
import os

from dotenv import load_dotenv

load_dotenv()


def _require(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"Missing required env var: {name}")
    return value


# --- Core services -----------------------------------------------------------
ANTHROPIC_API_KEY = _require("ANTHROPIC_API_KEY")
ANTHROPIC_MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-4-5")

DAILY_API_KEY = _require("DAILY_API_KEY")
DAILY_API_URL = os.environ.get("DAILY_API_URL", "https://api.daily.co/v1")

# --- STT: Deepgram primary, AssemblyAI fallback, switchable via env ----------
STT_PROVIDER = os.environ.get("STT_PROVIDER", "deepgram").strip().lower()
DEEPGRAM_API_KEY = os.environ.get("DEEPGRAM_API_KEY", "")
ASSEMBLYAI_API_KEY = os.environ.get("ASSEMBLYAI_API_KEY", "")

# --- TTS: Cartesia primary, Deepgram fallback, switchable via env ------------
TTS_PROVIDER = os.environ.get("TTS_PROVIDER", "cartesia").strip().lower()
CARTESIA_API_KEY = os.environ.get("CARTESIA_API_KEY", "")
CARTESIA_VOICE_ID = os.environ.get("CARTESIA_VOICE_ID", "79a125e8-cd45-4c13-8a67-188112f4dd22")
DEEPGRAM_TTS_VOICE = os.environ.get("DEEPGRAM_TTS_VOICE", "aura-2-thalia-en")

if STT_PROVIDER not in ("deepgram", "assemblyai"):
    raise RuntimeError(f"STT_PROVIDER must be 'deepgram' or 'assemblyai', got {STT_PROVIDER!r}")
if TTS_PROVIDER not in ("cartesia", "deepgram"):
    raise RuntimeError(f"TTS_PROVIDER must be 'cartesia' or 'deepgram', got {TTS_PROVIDER!r}")
if STT_PROVIDER == "deepgram" and not DEEPGRAM_API_KEY:
    raise RuntimeError("STT_PROVIDER=deepgram requires DEEPGRAM_API_KEY")
if STT_PROVIDER == "assemblyai" and not ASSEMBLYAI_API_KEY:
    raise RuntimeError("STT_PROVIDER=assemblyai requires ASSEMBLYAI_API_KEY")
if TTS_PROVIDER == "cartesia" and not CARTESIA_API_KEY:
    raise RuntimeError("TTS_PROVIDER=cartesia requires CARTESIA_API_KEY")
if TTS_PROVIDER == "deepgram" and not DEEPGRAM_API_KEY:
    raise RuntimeError("TTS_PROVIDER=deepgram requires DEEPGRAM_API_KEY")

# --- Neon (Postgres) -----------------------------------------------------------
DATABASE_URL = _require("DATABASE_URL")

# --- Cloudflare R2 (biosignal results) -----------------------------------------
R2_ACCOUNT_ID = _require("R2_ACCOUNT_ID")
R2_ACCESS_KEY_ID = _require("R2_ACCESS_KEY_ID")
R2_SECRET_ACCESS_KEY = _require("R2_SECRET_ACCESS_KEY")
R2_BUCKET_NAME = _require("R2_BUCKET_NAME")
R2_ENDPOINT_URL = os.environ.get(
    "R2_ENDPOINT_URL", f"https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
)

# --- Node/Vercel API (source of truth for writes to feedback_form etc.) -------
# The Pipecat backend calls back into the existing Node API's "tools/*" routes
# rather than duplicating INSERT/UPDATE logic in Python — see api/feedback/[...slug].js.
# NOTE: those routes (tools/save-answer, tools/finalize-session) currently have no
# auth of their own (this predates Stage 2 — see api/feedback/[...slug].js:87-136).
# APP_INTERNAL_API_KEY is optional and forward-compatible: if set, it's sent as
# `x-internal-api-key`, but nothing on the Node side checks it yet. Tighten that
# in a follow-up if you want these write-path routes locked down.
APP_API_BASE_URL = _require("APP_API_BASE_URL")  # e.g. https://your-app.vercel.app
APP_INTERNAL_API_KEY = os.environ.get("APP_INTERNAL_API_KEY", "")

# --- Auth ------------------------------------------------------------------------
# Same secret the Node API signs login JWTs with (api/_auth.js: jwt.sign({sub, role},
# JWT_SECRET)). Required so /connect can verify who's asking before it lets a Claude
# session query Neon/R2 for a given patient_id — see server.py's auth check.
JWT_SECRET = _require("JWT_SECRET")

# --- Server ---------------------------------------------------------------------
PORT = int(os.environ.get("PORT", "7860"))

# Comma-separated list of exact frontend origins allowed to call /connect (CORS).
# Defaults to permissive for local dev; set explicitly in production.
FRONTEND_ORIGINS = [
    o.strip() for o in os.environ.get("FRONTEND_ORIGINS", "*").split(",") if o.strip()
]
