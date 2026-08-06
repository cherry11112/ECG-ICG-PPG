// Shared Pipecat voice-agent client wiring, used by patient1.html and P1report.html.
// Replaces the old browser-SpeechRecognition + /api/n8n widget (removed in Stage 1/2):
// audio now streams both ways over Daily WebRTC; STT/TTS/LLM all run server-side in
// the Pipecat backend (see backend/bot.py). This module only handles the browser side:
// mic permission, connecting to the backend's /connect endpoint, playing the bot's
// audio track, and surfacing status/transcript/tool-result events to the caller.
//
// Loaded via CDN ESM (same convention this repo already uses for Chart.js/Popper —
// see patient1.html/P1report.html <script> tags) since there is no frontend bundler.
import { PipecatClient } from 'https://cdn.jsdelivr.net/npm/@pipecat-ai/client-js@1.13.0/+esm'
import { DailyTransport } from 'https://cdn.jsdelivr.net/npm/@pipecat-ai/daily-transport@1.6.8/+esm'

/**
 * @param {Object} opts
 * @param {string} opts.backendUrl - Base URL of the Pipecat backend (Railway), e.g. https://your-app.up.railway.app
 * @param {string} opts.token - The user's login JWT (localStorage 'token'). Required —
 *   the backend rejects /connect without it, and a patient token may only request
 *   their own patient_id (see backend/server.py's authorize_connect_request).
 * @param {number} opts.patientId
 * @param {'daily_feedback'|'data_query'|'general_chat'} opts.mode
 * @param {string} [opts.sessionId]
 * @param {(text: string, kind?: 'info'|'success'|'error'|'muted') => void} [opts.onStatus]
 * @param {(role: 'you'|'assistant', text: string) => void} [opts.onTranscript]
 * @param {(functionName: string, result: any) => void} [opts.onToolResult]
 * @param {HTMLAudioElement} opts.audioEl - <audio> element the bot's voice will play through
 */
export function createVoiceSession(opts) {
  const { backendUrl, token, patientId, mode, sessionId, onStatus, onTranscript, onToolResult, audioEl } = opts

  if (!backendUrl) throw new Error('createVoiceSession: backendUrl is required')
  if (!token) throw new Error('createVoiceSession: token is required (backend requires auth on /connect)')

  const transport = new DailyTransport()

  const client = new PipecatClient({
    transport,
    enableMic: true,
    enableCam: false,
    callbacks: {
      onConnected: () => onStatus?.('Connected — starting assistant…', 'info'),
      onBotReady: () => onStatus?.('Assistant ready — go ahead and speak', 'success'),
      onDisconnected: () => onStatus?.('Session ended', 'muted'),
      onError: (message) => onStatus?.('Error: ' + (message?.data?.message || 'Something went wrong'), 'error'),
      onDeviceError: (err) => onStatus?.('Microphone problem (' + err.type + '). Check browser mic permission.', 'error'),
      onUserTranscript: (data) => {
        if (data.final) onTranscript?.('you', data.text)
      },
      onBotTranscript: (data) => onTranscript?.('assistant', data.text),
      onLLMFunctionCallStarted: (data) => {
        onStatus?.('Looking up ' + (data.function_name || 'data') + '…', 'muted')
      },
      onLLMFunctionCallStopped: (data) => {
        if (data.result !== undefined) onToolResult?.(data.function_name, data.result)
      },
      onTrackStarted: (track, participant) => {
        if (!participant || participant.local) return
        if (track.kind !== 'audio') return
        if (audioEl) {
          audioEl.srcObject = new MediaStream([track])
          audioEl.play().catch((e) => console.warn('Autoplay blocked, waiting for user gesture:', e))
        }
      },
      onTrackStopped: (track) => {
        if (audioEl && audioEl.srcObject) {
          const ms = audioEl.srcObject
          if (ms.getTracks && ms.getTracks().includes(track)) audioEl.srcObject = null
        }
      },
    },
  })

  async function connect() {
    onStatus?.('Requesting microphone…', 'info')
    // 60s, not 15s: free-tier backend hosting (Render's free plan) sleeps after
    // ~15 min idle and can take 30-60s to wake on the first request after that —
    // a short timeout here aborts the connection before the backend even gets a
    // chance to respond, which looks identical to a real failure from the UI.
    onStatus?.('Connecting… this can take up to a minute if the server was idle', 'info')
    await client.startBotAndConnect({
      endpoint: `${backendUrl.replace(/\/$/, '')}/connect`,
      headers: new Headers({ Authorization: `Bearer ${token}` }),
      requestData: { patient_id: patientId, mode, session_id: sessionId },
      timeout: 60000,
    })
  }

  async function disconnect() {
    await client.disconnect()
  }

  return { client, connect, disconnect }
}
