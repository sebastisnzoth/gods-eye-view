import { createVoiceCommands as bindVoiceCommands } from './sessionCommands.js';
import { createRealtimeSession } from './realtimeSession.js';
import { createGeminiSession } from './geminiSession.js';

/**
 * Gemini Live is the production default. OpenAI Realtime remains available as
 * an explicit compatibility fallback by setting window.__GEV_VOICE_PROVIDER__
 * to "openai" before voice initialization or by supplying createSession.
 */
export function createVoiceCommands(options = {}) {
  const configuredProvider =
    globalThis.window?.__GEV_VOICE_PROVIDER__ === 'openai'
      ? 'openai'
      : 'gemini';
  const createSession =
    options.createSession ||
    (configuredProvider === 'openai'
      ? createRealtimeSession
      : createGeminiSession);

  return bindVoiceCommands({
    ...options,
    createSession,
  });
}
