"""Pipecat voice agent: Daily transport + Claude LLM + switchable STT/TTS.

Verified against pipecat-ai==1.5.0 (see backend/requirements.txt) — class names
and constructor signatures were confirmed by introspecting the installed package,
not assumed from memory, since this API has changed across pipecat versions.

Run standalone (used by server.py, which spawns this as a subprocess per session):

    python bot.py --room-url <daily room> --token <daily token> \
        --patient-id 123 --session-id abc --mode daily_feedback

NOTE: joining a Daily room requires the `daily-python` package, which only ships
Linux/macOS wheels — this file cannot run natively on Windows. Use WSL2, Docker,
or Railway (Linux) to actually run the bot. Everything else in this backend
(the /connect endpoint, the Neon/R2 tools) works fine on native Windows.
"""
from __future__ import annotations

import argparse
import asyncio

from loguru import logger

import config
import prompts
from tools import feedback as feedback_tools
from tools import neon as neon_tools
from tools import r2 as r2_tools


def _build_stt():
    if config.STT_PROVIDER == "deepgram":
        from pipecat.services.deepgram.stt import DeepgramSTTService

        return DeepgramSTTService(api_key=config.DEEPGRAM_API_KEY)
    else:
        from pipecat.services.assemblyai.stt import AssemblyAISTTService

        return AssemblyAISTTService(api_key=config.ASSEMBLYAI_API_KEY)


def _build_tts():
    if config.TTS_PROVIDER == "cartesia":
        from pipecat.services.cartesia.tts import CartesiaTTSService, CartesiaTTSSettings

        return CartesiaTTSService(
            api_key=config.CARTESIA_API_KEY,
            settings=CartesiaTTSSettings(voice=config.CARTESIA_VOICE_ID),
        )
    else:
        from pipecat.services.deepgram.tts import DeepgramTTSService, DeepgramTTSSettings

        return DeepgramTTSService(
            api_key=config.DEEPGRAM_API_KEY,
            settings=DeepgramTTSSettings(voice=config.DEEPGRAM_TTS_VOICE),
        )


def _build_llm():
    if config.LLM_PROVIDER == "gemini":
        from pipecat.services.google.llm import GoogleLLMService, GoogleLLMSettings

        return GoogleLLMService(
            api_key=config.GEMINI_API_KEY,
            settings=GoogleLLMSettings(model=config.GEMINI_MODEL),
        )
    else:
        from pipecat.services.anthropic.llm import AnthropicLLMService, AnthropicLLMSettings

        return AnthropicLLMService(
            api_key=config.ANTHROPIC_API_KEY,
            settings=AnthropicLLMSettings(model=config.ANTHROPIC_MODEL),
        )


def _build_llm_and_context(mode: str):
    from pipecat.adapters.schemas.tools_schema import ToolsSchema
    from pipecat.processors.aggregators.llm_context import LLMContext
    from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair

    llm = _build_llm()

    llm.register_function("get_patient_context", neon_tools.get_patient_context_handler)
    llm.register_function("get_biosignal_result", r2_tools.get_biosignal_result_handler)
    llm.register_function("save_feedback_answer", feedback_tools.save_feedback_answer_handler)
    llm.register_function("finalize_feedback_session", feedback_tools.finalize_feedback_session_handler)

    tools = ToolsSchema(
        standard_tools=[
            neon_tools.get_patient_context_schema,
            r2_tools.get_biosignal_result_schema,
            feedback_tools.save_feedback_answer_schema,
            feedback_tools.finalize_feedback_session_schema,
        ]
    )

    system_prompt = prompts.build_system_prompt(mode)
    context = LLMContext(messages=[{"role": "system", "content": system_prompt}], tools=tools)
    context_aggregator = LLMContextAggregatorPair(context)

    return llm, context_aggregator


async def run_bot(room_url: str, token: str, patient_id: int, session_id: str, mode: str) -> None:
    from pipecat.audio.vad.silero import SileroVADAnalyzer
    from pipecat.audio.vad.vad_analyzer import VADParams
    from pipecat.frames.frames import LLMRunFrame
    from pipecat.pipeline.pipeline import Pipeline
    from pipecat.pipeline.runner import PipelineRunner
    from pipecat.pipeline.worker import PipelineParams, PipelineWorker
    from pipecat.processors.audio.vad_processor import VADProcessor
    from pipecat.transports.daily.transport import DailyParams, DailyTransport

    await neon_tools.init_pool(config.DATABASE_URL)
    r2_tools.init_client(config.R2_ENDPOINT_URL, config.R2_ACCESS_KEY_ID, config.R2_SECRET_ACCESS_KEY)
    feedback_tools.init_client(config.APP_API_BASE_URL, config.APP_INTERNAL_API_KEY)

    transport = DailyTransport(
        room_url,
        token,
        "Cardiac Assistant",
        DailyParams(
            api_url=config.DAILY_API_URL,
            api_key=config.DAILY_API_KEY,
            audio_in_enabled=True,
            audio_out_enabled=True,
        ),
    )

    stt = _build_stt()
    tts = _build_tts()
    llm, context_aggregator = _build_llm_and_context(mode)
    # Use less-aggressive VAD params to avoid chopping off user speech.
    # Defaults in the library are fairly high for `min_volume` and `confidence`,
    # which can cause the detector to miss quieter syllables or cut turns short.
    vad_params = VADParams(confidence=0.6, start_secs=0.12, stop_secs=0.35, min_volume=0.02)
    vad = VADProcessor(vad_analyzer=SileroVADAnalyzer(params=vad_params))

    pipeline = Pipeline(
        [
            transport.input(),
            vad,
            stt,
            context_aggregator.user(),
            llm,
            tts,
            transport.output(),
            context_aggregator.assistant(),
        ]
    )

    worker = PipelineWorker(
        pipeline,
        params=PipelineParams(),
        app_resources={"patient_id": patient_id, "session_id": session_id, "mode": mode},
    )

    @transport.event_handler("on_client_disconnected")
    async def on_disconnected(_transport, _client):
        logger.info(f"Client disconnected — ending session {session_id}")
        await worker.cancel()

    @transport.event_handler("on_joined")
    async def on_joined(_transport, _data):
        logger.info(f"Bot joined room for session {session_id} (patient {patient_id}, mode {mode})")

    @transport.event_handler("on_client_connected")
    async def on_client_connected(_transport, _participant):
        # The pipeline only reacts to STT output by default — nothing makes the bot
        # speak first on its own. Without this, the agent just sits silently waiting
        # for the patient to talk, which is backwards (they don't know what to say
        # first). Queuing an LLMRunFrame tells the LLM to generate a turn from
        # whatever's currently in context (just the system prompt at this point),
        # which is what the "start the conversation yourself" instruction in each
        # mode's prompt (prompts.py) is written to trigger.
        logger.info(f"Client connected for session {session_id} — triggering opening greeting")
        await worker.queue_frames([LLMRunFrame()])

    runner = PipelineRunner()
    try:
        await runner.run(worker)
    finally:
        await neon_tools.close_pool()
        await feedback_tools.close_client()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--room-url", required=True)
    parser.add_argument("--token", required=True)
    parser.add_argument("--patient-id", required=True, type=int)
    parser.add_argument("--session-id", required=True)
    parser.add_argument(
        "--mode", required=True, choices=["daily_feedback", "data_query", "general_chat"]
    )
    args = parser.parse_args()

    asyncio.run(
        run_bot(args.room_url, args.token, args.patient_id, args.session_id, args.mode)
    )


if __name__ == "__main__":
    main()
