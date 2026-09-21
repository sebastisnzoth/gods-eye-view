import { GEV_ACTION_SCHEMAS } from './actionSchemas.js';

const GEMINI_TOKEN_ENDPOINT = '/api/gemini/token';
const GEMINI_WS_ENDPOINT =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained';

function cleanModel(value) {
  const model = String(value || 'gemini-3.8-live').trim();
  return model.startsWith('models/') ? model : `models/${model}`;
}

function safeJson(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value ?? '');
  }
}

function toolSchema(value) {
  if (Array.isArray(value)) return value.map(toolSchema);
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    // Gemini's function declaration schema does not need JSON Schema's
    // additionalProperties flag and older Live models may reject it.
    if (key === 'additionalProperties') continue;
    result[key] = toolSchema(child);
  }
  return result;
}

function functionDeclarations() {
  return GEV_ACTION_SCHEMAS.map(({ name, parameters }) => ({
    name,
    description: `God's Eye View action: ${name.replaceAll('_', ' ')}`,
    parameters: toolSchema(parameters),
  }));
}

function bytesToBase64(bytes) {
  let binary = '';
  const size = 0x8000;
  for (let i = 0; i < bytes.length; i += size) {
    binary += String.fromCharCode(...bytes.subarray(i, i + size));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(String(value || ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1)
    bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function downsamplePcm16(input, inputRate, outputRate = 16000) {
  if (!input?.length || !Number.isFinite(inputRate) || inputRate <= 0)
    return new Uint8Array();
  const ratio = inputRate / outputRate;
  const length = Math.max(1, Math.floor(input.length / ratio));
  const pcm = new Int16Array(length);
  for (let i = 0; i < length; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.max(start + 1, Math.floor((i + 1) * ratio));
    let total = 0;
    let count = 0;
    for (let j = start; j < end && j < input.length; j += 1) {
      total += input[j];
      count += 1;
    }
    const sample = Math.max(-1, Math.min(1, total / Math.max(1, count)));
    pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return new Uint8Array(pcm.buffer);
}

function waitForSetup(socket, signal, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    let timer;
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      socket.removeEventListener?.('message', onMessage);
      socket.removeEventListener?.('close', onClose);
      socket.removeEventListener?.('error', onError);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onAbort = () =>
      finish(
        reject,
        new DOMException('Voice startup cancelled', 'AbortError'),
      );
    const onError = () =>
      finish(reject, new Error('Gemini Live WebSocket connection failed'));
    const onClose = (event) =>
      finish(
        reject,
        new Error(
          event?.reason
            ? `Gemini Live rejected setup: ${event.reason}`
            : `Gemini Live rejected setup (code ${event?.code || 'unknown'})`,
        ),
      );
    const onMessage = (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message?.setupComplete) finish(resolve);
      else if (message?.error)
        finish(
          reject,
          new Error(
            message.error.message ||
              message.error.status ||
              'Gemini Live setup failed',
          ),
        );
    };

    timer = setTimeout(
      () => finish(reject, new Error('Gemini Live setup timed out')),
      timeoutMs,
    );
    signal?.addEventListener('abort', onAbort, { once: true });
    socket.addEventListener?.('message', onMessage);
    socket.addEventListener?.('close', onClose);
    socket.addEventListener?.('error', onError);
  });
}

/**
 * Gemini Live adapter for the common voice session.
 * Browser -> Gemini uses a short-lived token minted by /api/gemini/token.
 */
export function createGeminiSession({
  emit,
  runAction,
  ui,
  signal,
  tokenEndpoint = GEMINI_TOKEN_ENDPOINT,
  tokenTransport = (...args) => fetch(...args),
  WebSocketImpl = globalThis.WebSocket,
  mediaDevices = globalThis.navigator?.mediaDevices,
  AudioContextImpl = globalThis.AudioContext || globalThis.webkitAudioContext,
}) {
  let socket = null;
  let stream = null;
  let inputContext = null;
  let outputContext = null;
  let micSource = null;
  let processor = null;
  let silentGain = null;
  let startAbort = null;
  let setupReady = false;
  let intentionalClose = false;
  let nextPlaybackTime = 0;
  const playbackSources = new Set();

  const isOpen = () => socket?.readyState === WebSocketImpl?.OPEN;

  function setSpeaker(value) {
    if (ui?.root) ui.root.dataset.speaker = value;
  }

  function send(message) {
    if (!isOpen()) return false;
    socket.send(JSON.stringify(message));
    return true;
  }

  function stopPlayback() {
    for (const source of playbackSources) {
      try {
        source.stop();
      } catch {}
    }
    playbackSources.clear();
    nextPlaybackTime = 0;
    setSpeaker('idle');
  }

  function ensureOutputContext() {
    if (!AudioContextImpl) throw new Error('Web Audio is unavailable');
    if (!outputContext)
      outputContext = new AudioContextImpl({ latencyHint: 'interactive' });
    if (outputContext.state === 'suspended') void outputContext.resume();
    return outputContext;
  }

  function playAudio(base64, mimeType = 'audio/pcm;rate=24000') {
    const context = ensureOutputContext();
    const match = /rate=(\d+)/i.exec(String(mimeType));
    const sampleRate = Number(match?.[1]) || 24000;
    const bytes = base64ToBytes(base64);
    if (bytes.byteLength < 2) return;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const sampleCount = Math.floor(bytes.byteLength / 2);
    const buffer = context.createBuffer(1, sampleCount, sampleRate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < sampleCount; i += 1)
      channel[i] = view.getInt16(i * 2, true) / 32768;

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    const startAt = Math.max(context.currentTime + 0.02, nextPlaybackTime);
    nextPlaybackTime = startAt + buffer.duration;
    playbackSources.add(source);
    source.onended = () => {
      playbackSources.delete(source);
      if (!playbackSources.size) setSpeaker('idle');
    };
    setSpeaker('assistant');
    source.start(startAt);
  }

  async function handleToolCall(toolCall) {
    const calls = Array.isArray(toolCall?.functionCalls)
      ? toolCall.functionCalls
      : [];
    const functionResponses = [];
    for (const call of calls) {
      try {
        const result = await runAction(call.name, call.args || {});
        functionResponses.push({
          name: call.name,
          id: call.id,
          response: { result: safeJson(result) },
        });
      } catch (error) {
        functionResponses.push({
          name: call.name,
          id: call.id,
          response: { error: error?.message || String(error) },
        });
      }
    }
    if (functionResponses.length)
      send({ toolResponse: { functionResponses } });
  }

  function handleMessage(event) {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }

    if (message.setupComplete) {
      socket?.__gevSetupComplete?.();
      socket.__gevSetupComplete = null;
      return;
    }

    if (message.toolCall) void handleToolCall(message.toolCall);

    const content = message.serverContent;
    if (!content) return;

    if (content.interrupted) {
      stopPlayback();
      emit({ type: 'interruption' });
    }
    if (content.inputTranscription?.text) {
      setSpeaker('user');
      emit({
        type: 'transcript',
        speaker: 'user',
        text: content.inputTranscription.text,
      });
    }
    if (content.outputTranscription?.text) {
      emit({
        type: 'transcript',
        speaker: 'assistant',
        text: content.outputTranscription.text,
      });
    }
    for (const part of content.modelTurn?.parts || []) {
      if (part.inlineData?.data)
        playAudio(part.inlineData.data, part.inlineData.mimeType);
    }
    if (content.turnComplete) {
      emit({ type: 'completion' });
      if (!playbackSources.size) setSpeaker('idle');
    }
  }

  async function startMicrophone() {
    if (!mediaDevices?.getUserMedia)
      throw new Error('Microphone access is unavailable in this browser');
    if (!AudioContextImpl) throw new Error('Web Audio is unavailable');

    stream = await mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    inputContext = new AudioContextImpl({ latencyHint: 'interactive' });
    if (inputContext.state === 'suspended') await inputContext.resume();
    micSource = inputContext.createMediaStreamSource(stream);
    processor = inputContext.createScriptProcessor(4096, 1, 1);
    silentGain = inputContext.createGain();
    silentGain.gain.value = 0;
    micSource.connect(processor);
    processor.connect(silentGain);
    silentGain.connect(inputContext.destination);

    processor.onaudioprocess = (event) => {
      if (!setupReady || !isOpen()) return;
      const pcm = downsamplePcm16(
        event.inputBuffer.getChannelData(0),
        inputContext.sampleRate,
        16000,
      );
      if (!pcm.byteLength) return;
      send({
        realtimeInput: {
          audio: {
            data: bytesToBase64(pcm),
            mimeType: 'audio/pcm;rate=16000',
          },
        },
      });
    };
  }

  async function requestToken(startSignal) {
    const response = await tokenTransport(tokenEndpoint, {
      cache: 'no-store',
      redirect: 'error',
      signal: startSignal,
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const reason =
        typeof data?.error === 'string' ? data.error : data?.error?.message;
      throw new Error(reason || `Gemini token failed: HTTP ${response.status}`);
    }
    if (typeof data?.token !== 'string' || !data.token)
      throw new Error('Gemini token response did not include a token');
    return { token: data.token, model: cleanModel(data.model) };
  }

  async function openSocket({ token, model }, startSignal) {
    if (!WebSocketImpl) throw new Error('WebSocket is unavailable');
    const url = `${GEMINI_WS_ENDPOINT}?access_token=${encodeURIComponent(token)}`;
    socket = new WebSocketImpl(url);

    // Install receive/close handlers before sending setup. Gemini can answer
    // with setupComplete immediately after the first frame; registering
    // onmessage afterwards creates a race that turns a successful handshake
    // into a false 15-second timeout.
    const setup = waitForSetup(socket, startSignal);
    socket.onmessage = handleMessage;

    await new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () =>
        startSignal?.removeEventListener('abort', aborted);
      const fail = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const aborted = () =>
        fail(new DOMException('Voice startup cancelled', 'AbortError'));

      startSignal?.addEventListener('abort', aborted, { once: true });

      socket.onerror = () =>
        fail(new Error('Gemini Live WebSocket connection failed'));

      socket.onclose = (event) => {
        setupReady = false;
        const detail = event.reason
          ? `Gemini Live closed during setup: ${event.reason}`
          : `Gemini Live closed during setup (code ${event.code || 'unknown'})`;
        fail(new Error(detail));
      };

      socket.onopen = () => {
        try {
          socket.send(
            JSON.stringify({
              setup: {
                // The ephemeral token contains the effective Live setup.
                // With an empty fieldMask, Gemini ignores connection-side
                // configuration and uses bidiGenerateContentSetup from token.
                model,
              },
            }),
          );
          settled = true;
          cleanup();
          resolve();
        } catch (error) {
          fail(error);
        }
      };
    });

    await setup;

    socket.onerror = () => {
      if (!intentionalClose)
        emit({
          type: 'state',
          state: 'error',
          detail: 'Gemini Live connection error',
        });
    };
    socket.onclose = (event) => {
      setupReady = false;
      if (!intentionalClose)
        emit({
          type: 'state',
          state: 'error',
          detail: event.reason
            ? `Gemini Live disconnected: ${event.reason}`
            : `Gemini Live disconnected (code ${event.code || 'unknown'})`,
        });
    };
  }

  async function start() {
    if (socket || stream) return;
    intentionalClose = false;
    startAbort = new AbortController();
    const startSignal = AbortSignal.any(
      [signal, startAbort.signal].filter(Boolean),
    );
    const credential = await requestToken(startSignal);
    await openSocket(credential, startSignal);
    setupReady = true;
    await startMicrophone();
    emit({ type: 'state', state: 'listening', detail: 'Gemini Live ready' });
  }

  function stop({ removeUi = false } = {}) {
    intentionalClose = true;
    setupReady = false;
    startAbort?.abort();
    startAbort = null;

    if (isOpen()) {
      try {
        send({ realtimeInput: { audioStreamEnd: true } });
      } catch {}
    }
    try {
      processor?.disconnect();
      micSource?.disconnect();
      silentGain?.disconnect();
    } catch {}
    processor = null;
    micSource = null;
    silentGain = null;

    for (const track of stream?.getTracks?.() || []) track.stop();
    stream = null;

    try {
      socket?.close(1000, 'client stop');
    } catch {}
    socket = null;

    stopPlayback();
    void inputContext?.close?.().catch?.(() => {});
    void outputContext?.close?.().catch?.(() => {});
    inputContext = null;
    outputContext = null;

    if (removeUi) ui?.root?.remove?.();
  }

  function sendText(text) {
    text = String(text || '').trim();
    if (!text || !isOpen()) return false;
    return send({
      clientContent: {
        turns: [{ role: 'user', parts: [{ text }] }],
        turnComplete: true,
      },
    });
  }

  function sendMapEvent() {
    // Gemini receives live map state through tool results and user commands.
    // Avoid unsolicited spoken replies for passive map events.
    return false;
  }

  signal?.addEventListener('abort', () => stop({ removeUi: true }), {
    once: true,
  });

  return {
    capabilities: { costControls: false, pushToTalk: false },
    start,
    stop,
    sendText,
    sendMapEvent,
    bindControls() {},
    ignoreButtonClick: () => false,
  };
}
