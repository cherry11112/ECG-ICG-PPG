"""FastAPI session-start server.

POST /connect creates a Daily room + token (via Daily's REST API — no daily-python
needed for this part) and spawns backend/bot.py as a subprocess to join it. The
client (frontend, Stage 3) gets back only the room URL and token; it joins the
Daily room directly with its own Daily client SDK — no API keys ever reach the
browser.

NOTE: spawning bot.py only succeeds on a platform with the `daily-python` package
available (Linux/macOS — i.e. Railway in production, or WSL2/Docker locally on
Windows). /connect itself runs fine anywhere.
"""
from __future__ import annotations

import subprocess
import sys
import uuid

import aiohttp
import jwt
from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

import config
from pipecat.runner.daily import configure

app = FastAPI(title="ECG Voice Agent Backend")

# The frontend (Vercel) calls this service cross-origin (Railway), so the browser
# needs an explicit CORS allow — set FRONTEND_ORIGINS to a comma-separated list of
# exact origins in production (e.g. "https://your-app.vercel.app").
app.add_middleware(
    CORSMiddleware,
    allow_origins=config.FRONTEND_ORIGINS,
    allow_methods=["POST", "GET", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization"],
)


class ConnectRequest(BaseModel):
    patient_id: int
    mode: str = "general_chat"  # daily_feedback | data_query | general_chat
    session_id: str | None = None


class ConnectResponse(BaseModel):
    room_url: str
    token: str
    session_id: str


VALID_MODES = {"daily_feedback", "data_query", "general_chat"}


def authorize_connect_request(authorization: str | None, patient_id: int) -> dict:
    """Verify the caller's login JWT (same one api/_auth.js issues) and confirm
    they're allowed to start a session about `patient_id`.

    This is the access-control gate for the Neon/R2 tools: whatever patient_id
    passes this check is what get_patient_context/get_biosignal_result will be
    called with for the rest of the session, so this must not be skippable.

    - patients may only start a session about themselves (sub == patient_id)
    - doctors may start a session about any patient — this mirrors the existing
      app-wide behavior (GET /api/doctor returns *all* patients to any doctor;
      there is no doctor-patient assignment table anywhere in this codebase).
      Tightening that is a product/schema decision, not a Stage 4 deployment fix.
    """
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "Missing bearer token")
    token = authorization.removeprefix("Bearer ").strip()
    try:
        # api/_auth.js signs `sub` as a number (jwt.sign({ sub: user.id, role }, ...)),
        # but PyJWT enforces the JWT spec's sub-must-be-a-string rule by default and
        # will reject an otherwise-valid token from the Node side without this.
        claims = jwt.decode(
            token, config.JWT_SECRET, algorithms=["HS256"], options={"verify_sub": False}
        )
    except jwt.PyJWTError as exc:
        raise HTTPException(401, f"Invalid token: {exc}") from exc

    role = claims.get("role")
    sub = claims.get("sub")
    if role not in ("patient", "doctor") or sub is None:
        raise HTTPException(401, "Malformed token")

    if role == "patient" and int(sub) != patient_id:
        raise HTTPException(403, "Patients may only start a session about themselves")

    return claims


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/connect", response_model=ConnectResponse)
async def connect(req: ConnectRequest, authorization: str | None = Header(default=None)):
    authorize_connect_request(authorization, req.patient_id)

    if req.mode not in VALID_MODES:
        raise HTTPException(400, f"mode must be one of {sorted(VALID_MODES)}")

    session_id = req.session_id or f"session_{req.patient_id}_{uuid.uuid4().hex[:8]}"

    async with aiohttp.ClientSession() as http_session:
        try:
            room_config = await configure(http_session, api_key=config.DAILY_API_KEY)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(502, f"Failed to create Daily room: {exc}") from exc

    try:
        subprocess.Popen(
            [
                sys.executable,
                "bot.py",
                "--room-url", room_config.room_url,
                "--token", room_config.token,
                "--patient-id", str(req.patient_id),
                "--session-id", session_id,
                "--mode", req.mode,
            ],
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(500, f"Failed to start bot process: {exc}") from exc

    return ConnectResponse(room_url=room_config.room_url, token=room_config.token, session_id=session_id)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=config.PORT)
