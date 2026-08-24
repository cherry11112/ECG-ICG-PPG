"""Claude tools for the daily_feedback flow.

These replace what n8n's AI agent used to do: call back into this app's own
Node API (api/feedback/[...slug].js tools/save-answer and tools/finalize-session)
to persist each answer and then commit the completed session to feedback_form.
We call the existing endpoints rather than duplicating their INSERT/UPDATE logic
in Python, so there's one source of truth for the write path (see Stage 1 audit).
"""
from __future__ import annotations

import httpx

from pipecat.adapters.schemas.function_schema import FunctionSchema

from prompts import VALID_QUESTION_IDS

_http: httpx.AsyncClient | None = None
_base_url: str = ""
_internal_api_key: str = ""


def init_client(base_url: str, internal_api_key: str = "") -> None:
    global _http, _base_url, _internal_api_key
    _base_url = base_url.rstrip("/")
    _internal_api_key = internal_api_key
    if _http is None:
        headers = {"x-internal-api-key": internal_api_key} if internal_api_key else {}
        _http = httpx.AsyncClient(base_url=_base_url, headers=headers, timeout=15.0)


async def close_client() -> None:
    global _http
    if _http is not None:
        await _http.aclose()
        _http = None


async def save_feedback_answer(patient_id: int, session_id: str, question_id: str, answer_value: str) -> dict:
    if _http is None:
        raise RuntimeError("feedback tools client not initialized — call init_client() first")
    resp = await _http.post(
        "/api/feedback/tools/save-answer",
        json={
            "patient_id": patient_id,
            "session_id": session_id,
            "question_id": question_id,
            "answer_value": answer_value,
        },
    )
    resp.raise_for_status()
    return resp.json()


async def save_followup_answer(
    patient_id: int, session_id: str, question_id: str, question_context: str, answer_text: str
) -> dict:
    if _http is None:
        raise RuntimeError("feedback tools client not initialized — call init_client() first")
    resp = await _http.post(
        "/api/feedback/tools/save-followup-answer",
        json={
            "patient_id": patient_id,
            "session_id": session_id,
            "question_id": question_id,
            "question_context": question_context,
            "answer_text": answer_text,
        },
    )
    resp.raise_for_status()
    return resp.json()


PROFILE_NOTE_CATEGORIES = ["background", "medical_history", "family_history", "lifestyle", "other"]


async def save_profile_note(
    patient_id: int, session_id: str, category: str, question_text: str, answer_text: str
) -> dict:
    if _http is None:
        raise RuntimeError("feedback tools client not initialized — call init_client() first")
    resp = await _http.post(
        "/api/feedback/tools/save-profile-note",
        json={
            "patient_id": patient_id,
            "session_id": session_id,
            "category": category,
            "question_text": question_text,
            "answer_text": answer_text,
        },
    )
    resp.raise_for_status()
    return resp.json()


async def finalize_feedback_session(patient_id: int, session_id: str) -> dict:
    if _http is None:
        raise RuntimeError("feedback tools client not initialized — call init_client() first")
    resp = await _http.post(
        "/api/feedback/tools/finalize-session",
        json={"patient_id": patient_id, "session_id": session_id},
    )
    resp.raise_for_status()
    return resp.json()


async def save_feedback_answer_handler(params) -> None:
    # patient_id and session_id come from app_resources (established once at
    # /connect time, JWT-verified) — not from the LLM's tool-call arguments.
    # Trusting LLM-supplied identity/session values here is exactly how a
    # hallucinated or wrong patient_id ends up violating the DB's foreign key
    # constraint (or worse, writing to the wrong patient's records).
    result = await save_feedback_answer(
        patient_id=int(params.app_resources["patient_id"]),
        session_id=str(params.app_resources["session_id"]),
        question_id=str(params.arguments["question_id"]),
        answer_value=str(params.arguments["answer_value"]),
    )
    await params.result_callback(result)


async def save_followup_answer_handler(params) -> None:
    result = await save_followup_answer(
        patient_id=int(params.app_resources["patient_id"]),
        session_id=str(params.app_resources["session_id"]),
        question_id=str(params.arguments["question_id"]),
        question_context=str(params.arguments["question_context"]),
        answer_text=str(params.arguments["answer_text"]),
    )
    await params.result_callback(result)


async def save_profile_note_handler(params) -> None:
    result = await save_profile_note(
        patient_id=int(params.app_resources["patient_id"]),
        session_id=str(params.app_resources["session_id"]),
        category=str(params.arguments["category"]),
        question_text=str(params.arguments["question_text"]),
        answer_text=str(params.arguments["answer_text"]),
    )
    await params.result_callback(result)


async def finalize_feedback_session_handler(params) -> None:
    result = await finalize_feedback_session(
        patient_id=int(params.app_resources["patient_id"]),
        session_id=str(params.app_resources["session_id"]),
    )
    await params.result_callback(result)


save_feedback_answer_schema = FunctionSchema(
    name="save_feedback_answer",
    description=(
        "Save one answer from the daily symptom check-in. Call this once per "
        "question, immediately after the patient answers it."
    ),
    properties={
        "question_id": {
            "type": "string",
            "enum": VALID_QUESTION_IDS,
            "description": "Which question this answer is for.",
        },
        "answer_value": {
            "type": "string",
            "description": "The normalized answer (e.g. 'Yes', 'No', a number, or a short phrase).",
        },
    },
    required=["question_id", "answer_value"],
)

save_followup_answer_schema = FunctionSchema(
    name="save_followup_answer",
    description=(
        "Save the patient's answer to an AI-generated follow-up question (a question "
        "not on the fixed 27-question list, asked to clarify or get more detail on a "
        "prior answer). This is stored in that same question's own free-text column — "
        "it never overwrites the structured answer already saved by save_feedback_answer "
        "for that question."
    ),
    properties={
        "question_id": {
            "type": "string",
            "enum": VALID_QUESTION_IDS,
            "description": "The same question_id the follow-up relates to (the one just answered).",
        },
        "question_context": {
            "type": "string",
            "description": (
                "Short label for what the follow-up was about, so the note is "
                "understandable on its own later (e.g. 'Chest pain location', "
                "'Chest pain trigger')."
            ),
        },
        "answer_text": {
            "type": "string",
            "description": "The patient's answer to the follow-up question.",
        },
    },
    required=["question_id", "question_context", "answer_text"],
)

save_profile_note_schema = FunctionSchema(
    name="save_profile_note",
    description=(
        "Save one of the 6 general profile-building questions asked before the standard "
        "27-question daily feedback flow, along with the patient's answer. These notes "
        "accumulate in the patient's profile across all sessions (never overwritten), so "
        "check get_patient_context first to see what's already on file. Call this once "
        "per general question, immediately after the patient answers it."
    ),
    properties={
        "category": {
            "type": "string",
            "enum": PROFILE_NOTE_CATEGORIES,
            "description": (
                "What kind of profile information this question/answer covers: "
                "'background' (general patient background), 'medical_history' "
                "(the patient's own long-term medical history), 'family_history' "
                "(family health history), 'lifestyle' (lifestyle/environmental factors), "
                "or 'other' (any other relevant patient characteristic)."
            ),
        },
        "question_text": {
            "type": "string",
            "description": "The exact question you asked the patient.",
        },
        "answer_text": {
            "type": "string",
            "description": "The patient's answer, summarized naturally (not necessarily verbatim).",
        },
    },
    required=["category", "question_text", "answer_text"],
)

finalize_feedback_session_schema = FunctionSchema(
    name="finalize_feedback_session",
    description=(
        "Commit the daily feedback session once all 27 questions have been answered. "
        "If the session is incomplete, the result will say so and list what's missing — "
        "keep collecting answers in that case rather than retrying this call immediately."
    ),
    properties={},
    required=[],
)
