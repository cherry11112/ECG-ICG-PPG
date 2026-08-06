"""Claude tool: fetch a biosignal result object from Cloudflare R2 and summarize it.

Target key convention (per your explicit decision — patient_id- and signal_type-
scoped, not the legacy single global file):

    patients/{patient_id}/{signal_type}_results.json

signal_type is one of: ecg, ppg, icg, pcg

STATUS AS OF THIS CHECK (verified live against the real "signals-result" bucket):
nothing exists at `patients/` yet — the Python biosignal pipeline currently writes
ONE global file at `data/ecg_results.json` with `patientId: null`, combining ECG +
PPG + ICG (no PCG) in a single object. That means today `get_biosignal_result`
correctly returns `{"ready": false}` for every patient — which is the safe
behavior (never guesses whose data it is), but nobody gets real answers until
the pipeline is updated. See "PIPELINE CHANGE NEEDED" in backend/README.md for
the exact spec of what the Python side needs to write.

The field-mapping below (metrics.ecg_heart_rate, measurements.qrs_width_mean in
*seconds*, etc.) is taken directly from the real combined file's schema, on the
assumption the pipeline will keep using the same field names when it starts
writing one file per patient per signal_type — adjust here (not at call sites)
if that assumption turns out wrong once real per-patient files start appearing.

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
    "R2_KEY_TEMPLATE", "patients/{patient_id}/{signal_type}_results.json"
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

    key = R2_KEY_TEMPLATE.format(patient_id=patient_id, signal_type=signal_type)
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
