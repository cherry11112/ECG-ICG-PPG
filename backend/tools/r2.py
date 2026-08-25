"""Claude tool: fetch a biosignal result object from Cloudflare R2 and summarize it.

Key convention (patient_id- and signal-type-scoped — never a shared/global file):

    data/{patient_id}/{SIGNAL}/processed_{signal_type}.json

SIGNAL is the uppercased signal_type (ECG, ICG, PPG, PCG). This matches what
run_analysis.py now writes: one combined ECG+PPG+ICG result object, uploaded
under each signal's own folder so a lookup by signal_type finds a patient-scoped
file. (PCG isn't produced by any script yet — a lookup for it will just find no
key, same as before.) A `history/{run_timestamp}.json` copy also exists
alongside each "current" file — this tool only ever reads "current".

The field-mapping below (metrics.ecg_heart_rate, measurements.qrs_width_mean in
*seconds*, etc.) is taken directly from the combined file's real schema.

Raw signal/waveform data (the `signals.*` arrays, tens of thousands of points
each) is never forwarded to Claude — only numeric summaries.
"""
from __future__ import annotations

import json
import os

import boto3
from botocore.config import Config as BotoConfig
from loguru import logger

from pipecat.adapters.schemas.function_schema import FunctionSchema

SIGNAL_TYPES = ("ecg", "ppg", "icg", "pcg")

R2_KEY_TEMPLATE = os.environ.get(
    "R2_KEY_TEMPLATE", "data/{patient_id}/{signal_type_upper}/processed_{signal_type}.json"
)

_client = None


def init_client(endpoint_url: str, access_key_id: str, secret_access_key: str):
    global _client
    if _client is None:
        _client = boto3.client(
            "s3",
            endpoint_url=endpoint_url,
            aws_access_key_id=access_key_id,
            aws_secret_access_key=secret_access_key,
            config=BotoConfig(signature_version="s3v4"),
            region_name="auto",
        )
    return _client


def _summarize(signal_type: str, data: dict) -> dict:
    """Numerically summarize a biosignal result object for the LLM.

    Field names/units verified against a real production result object
    (data/ecg_results.json in the "signals-result" bucket) — not guessed.
    """
    metrics = data.get("metrics") or {}
    measurements = data.get("measurements") or {}
    metadata = data.get("metadata") or {}

    summary = {
        "signal_type": signal_type,
        "summary": data.get("summary") or data.get("diagnostic_summary"),
        "rhythm": data.get("rhythm"),
        "abnormalities": data.get("abnormalities") or [],
        "generated_at": metadata.get("processingDate") or data.get("generated_at"),
    }

    if signal_type == "ecg":
        summary["measurements"] = {
            "heart_rate_bpm": metrics.get("ecg_heart_rate") or data.get("hr_mean"),
            "heart_rate_min_bpm": data.get("hr_min"),
            "heart_rate_max_bpm": data.get("hr_max"),
            "qrs_width_mean_s": measurements.get("qrs_width_mean"),
            "qt_interval_mean_s": measurements.get("qt_interval_mean"),
            "qtc_interval_mean_s": measurements.get("qtc_interval_mean"),
            "pr_interval_mean_s": measurements.get("pr_interval_mean"),
            "st_analysis": data.get("st_analysis"),
        }
    elif signal_type == "ppg":
        summary["measurements"] = {
            "heart_rate_bpm": metrics.get("ppg_heart_rate"),
            "systolic_bp_mean_mmhg": metrics.get("systolic_bp_mean"),
            "diastolic_bp_mean_mmhg": metrics.get("diastolic_bp_mean"),
        }
    elif signal_type == "icg":
        summary["measurements"] = {
            "heart_rate_bpm": metrics.get("icg_heart_rate"),
            "cardiac_output_l_per_min": metrics.get("icg_cardiac_output"),
            "stroke_volume_ml": metrics.get("icg_stroke_volume"),
            "pre_ejection_period_s": metrics.get("pep"),
            "lvet_s": metrics.get("lvet"),
        }
    else:  # pcg — pipeline does not produce this yet, but don't hardcode a refusal
        summary["measurements"] = measurements or {}

    return summary


async def get_biosignal_result(patient_id: int, signal_type: str) -> dict:
    if _client is None:
        raise RuntimeError("R2 client not initialized — call init_client() first")

    signal_type = signal_type.strip().lower()
    if signal_type not in SIGNAL_TYPES:
        return {"error": f"Unknown signal_type {signal_type!r}; expected one of {SIGNAL_TYPES}"}

    key = R2_KEY_TEMPLATE.format(
        patient_id=patient_id, signal_type=signal_type, signal_type_upper=signal_type.upper()
    )
    bucket = os.environ["R2_BUCKET_NAME"]

    try:
        obj = _client.get_object(Bucket=bucket, Key=key)
    except _client.exceptions.NoSuchKey:
        logger.info(f"[r2] No result yet at {key} (bucket={bucket})")
        return {"ready": False, "signal_type": signal_type, "message": "No result file found yet."}
    except Exception as exc:  # noqa: BLE001 - surface a speakable error, not a stack trace
        logger.warning(f"[r2] Error reading {key}: {exc}")
        return {"ready": False, "signal_type": signal_type, "message": f"Could not read result: {exc}"}

    body = obj["Body"].read()
    try:
        data = json.loads(body)
    except json.JSONDecodeError:
        return {"ready": False, "signal_type": signal_type, "message": "Result file was not valid JSON."}

    if data.get("patientId") not in (None, patient_id, str(patient_id)):
        logger.warning(
            f"[r2] {key} has patientId={data.get('patientId')!r}, "
            f"which doesn't match requested patient_id={patient_id!r}. Refusing to serve it."
        )
        return {"ready": False, "signal_type": signal_type, "message": "No result file found yet."}

    return {"ready": True, **_summarize(signal_type, data)}


async def get_biosignal_result_handler(params) -> None:
    # patient_id comes from app_resources (JWT-verified at /connect), not the
    # LLM's arguments — see the matching comment in tools/neon.py for why.
    patient_id = int(params.app_resources["patient_id"])
    signal_type = str(params.arguments["signal_type"])
    result = await get_biosignal_result(patient_id, signal_type)
    await params.result_callback(result)


get_biosignal_result_schema = FunctionSchema(
    name="get_biosignal_result",
    description=(
        "Fetch and numerically summarize the current patient's biosignal result "
        "(ECG, PPG, ICG, or PCG) from object storage. Returns a concise summary "
        "(heart rate, rhythm, key measurements, flagged abnormalities) — never "
        "raw waveform data. Check get_patient_context first to confirm a result "
        "is likely ready before calling this. Always refers to the patient this "
        "session belongs to."
    ),
    properties={
        "signal_type": {
            "type": "string",
            "enum": list(SIGNAL_TYPES),
            "description": "Which biosignal to fetch.",
        },
    },
    required=["signal_type"],
)
