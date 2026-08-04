"""Claude tool: query Neon (Postgres) for a patient's health context.

Reuses the same tables api/_db.js already reads for its "general chat context"
(getPatientHealthData) — feedback_form, report_form, diagnostic_results — rather
than inventing a parallel schema. All queries are parameterized asyncpg calls;
no string interpolation of user/LLM-supplied values into SQL.
"""
from __future__ import annotations

import asyncpg

from pipecat.adapters.schemas.function_schema import FunctionSchema

_pool: asyncpg.Pool | None = None


async def init_pool(database_url: str) -> asyncpg.Pool:
    global _pool
    if _pool is None:
        # Use Neon's pooled connection string (the "-pooler" host) here — each
        # Railway instance can otherwise exhaust Neon's direct connection limit
        # once more than a couple of voice sessions run concurrently.
        #
        # statement_cache_size=0 is required, not optional, when the connection
        # goes through Neon's pooler: it's PgBouncer in transaction-pooling mode,
        # which hands a query to a different backend connection each transaction.
        # asyncpg's default server-side prepared-statement cache assumes a stable
        # backend connection, so without this you'll intermittently hit
        # "prepared statement ... does not exist" errors under load.
        _pool = await asyncpg.create_pool(
            database_url, min_size=1, max_size=5, statement_cache_size=0
        )
    return _pool


async def close_pool() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


async def get_patient_context(patient_id: int) -> dict:
    """Fetch the patient's latest feedback, report, and diagnostic-status rows.

    Returns a compact dict — no raw jsonb blobs are passed through verbatim,
    just the fields useful for the assistant to reason about and speak from.
    """
    if _pool is None:
        raise RuntimeError("Neon pool not initialized — call init_pool() first")

    async with _pool.acquire() as conn:
        user_row = await conn.fetchrow(
            "SELECT id, full_name, role FROM users WHERE id = $1",
            patient_id,
        )
        if user_row is None:
            return {"error": f"No patient found with id {patient_id}"}

        feedback_row = await conn.fetchrow(
            """
            SELECT created_at, dyspnea, chest_pain, palpitations, leg_swelling,
                   weight_kg, blood_pressure_systolic, blood_pressure_diastolic,
                   fatigue_level, sleep_quality, free_comment
            FROM feedback_form
            WHERE patient_id = $1
            ORDER BY created_at DESC
            LIMIT 1
            """,
            patient_id,
        )

        report_row = await conn.fetchrow(
            """
            SELECT created_at, age, gender, bmi, smoking, diabetes,
                   heart_failure, blood_pressure, cholesterol, nyha, lvef
            FROM report_form
            WHERE patient_id = $1
            ORDER BY created_at DESC
            LIMIT 1
            """,
            patient_id,
        )

        diagnostic_row = await conn.fetchrow(
            """
            SELECT created_at, risk_level, risk_percentage, summary,
                   has_feedback_data, has_report_data, has_ecg_data,
                   cloudflare_json_url
            FROM diagnostic_results
            WHERE patient_id = $1
            ORDER BY created_at DESC
            LIMIT 1
            """,
            patient_id,
        )

    return {
        "patient": dict(user_row),
        "latest_feedback": dict(feedback_row) if feedback_row else None,
        "latest_report": dict(report_row) if report_row else None,
        "latest_diagnostic": dict(diagnostic_row) if diagnostic_row else None,
    }


async def get_patient_context_handler(params) -> None:
    patient_id = int(params.arguments["patient_id"])
    result = await get_patient_context(patient_id)
    await params.result_callback(result)


get_patient_context_schema = FunctionSchema(
    name="get_patient_context",
    description=(
        "Look up a patient's most recent symptom feedback, intake report, and "
        "diagnostic status (including whether biosignal results like ECG are "
        "ready) from the database. Call this before answering any question "
        "about a patient's recorded health data."
    ),
    properties={
        "patient_id": {
            "type": "integer",
            "description": "The patient's numeric user id.",
        }
    },
    required=["patient_id"],
)
