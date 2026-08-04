"""Local sanity check: confirms every pipeline component constructs without
error and the FastAPI app responds, without needing a live Daily room, real
provider credentials, or a live database. Run after `pip install -r
requirements.txt` and before wiring up real API keys.

    python smoke_test.py

This does NOT verify the full Daily join (daily-python has no Windows wheels;
run bot.py itself on Linux/WSL2/Railway for that) or that Neon/R2 credentials
are correct (see README.md for a real end-to-end test against your own DB/bucket).
"""
import os

os.environ.setdefault("ANTHROPIC_API_KEY", "test-key")
os.environ.setdefault("DAILY_API_KEY", "test-key")
os.environ.setdefault("DATABASE_URL", "postgres://user:pass@localhost/db")
os.environ.setdefault("R2_ACCOUNT_ID", "test")
os.environ.setdefault("R2_ACCESS_KEY_ID", "test")
os.environ.setdefault("R2_SECRET_ACCESS_KEY", "test")
os.environ.setdefault("R2_BUCKET_NAME", "test")
os.environ.setdefault("APP_API_BASE_URL", "http://localhost:3000")
os.environ.setdefault("DEEPGRAM_API_KEY", "test-key")
os.environ.setdefault("CARTESIA_API_KEY", "test-key")
os.environ.setdefault("JWT_SECRET", "test-jwt-secret-not-for-production")

import config
import bot


def main():
    print(f"STT_PROVIDER={config.STT_PROVIDER} TTS_PROVIDER={config.TTS_PROVIDER}")

    stt = bot._build_stt()
    print("STT service:", type(stt).__name__)

    tts = bot._build_tts()
    print("TTS service:", type(tts).__name__)

    llm, context_aggregator = bot._build_llm_and_context("daily_feedback")
    print("LLM service:", type(llm).__name__)
    for name in (
        "get_patient_context",
        "get_biosignal_result",
        "save_feedback_answer",
        "finalize_feedback_session",
    ):
        assert llm.has_function(name), f"tool {name} not registered"
    print("All 4 tools registered on the LLM service.")

    from pipecat.audio.vad.silero import SileroVADAnalyzer
    from pipecat.processors.audio.vad_processor import VADProcessor

    VADProcessor(vad_analyzer=SileroVADAnalyzer())
    print("VAD analyzer loaded.")

    from fastapi.testclient import TestClient
    import server

    client = TestClient(server.app)
    resp = client.get("/health")
    assert resp.status_code == 200, resp.text
    print("GET /health ->", resp.status_code, resp.json())

    import jwt as pyjwt

    secret = config.JWT_SECRET
    patient_token = pyjwt.encode({"sub": 1, "role": "patient"}, secret, algorithm="HS256")
    other_patient_token = pyjwt.encode({"sub": 2, "role": "patient"}, secret, algorithm="HS256")
    bad_token = pyjwt.encode({"sub": 1, "role": "patient"}, "wrong-secret", algorithm="HS256")

    def connect(headers=None, patient_id=1):
        return client.post(
            "/connect",
            json={"patient_id": patient_id, "mode": "general_chat"},
            headers=headers or {},
        )

    assert connect().status_code == 401, "missing token should 401"
    assert connect({"Authorization": f"Bearer {bad_token}"}).status_code == 401, "bad signature should 401"
    r = connect({"Authorization": f"Bearer {other_patient_token}"}, patient_id=1)
    assert r.status_code == 403, "patient requesting someone else's data should 403"
    # A patient requesting their own id passes auth and proceeds to Daily room
    # creation, which then fails against the fake DAILY_API_KEY above — 401/403
    # would mean the auth gate itself is broken; anything else means it passed.
    r = connect({"Authorization": f"Bearer {patient_token}"}, patient_id=1)
    assert r.status_code not in (401, 403), f"own-data request should pass auth, got {r.status_code}: {r.text}"
    print("/connect auth checks passed (missing/bad/cross-patient token correctly rejected).")

    print("\nSMOKE TEST PASSED — pipeline components and server construct correctly.")
    print("Not covered here: real Daily join (needs Linux/daily-python), real Neon/R2 calls.")


if __name__ == "__main__":
    main()
