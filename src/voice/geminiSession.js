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

const ACTION_DESCRIPTIONS = Object.freeze({
  fly_to_location:
    'Fly the globe camera to a city, address, landmark, coordinates or arbitrary place search query.',
  select_nearest_aircraft:
    'Select the nearest civilian or military aircraft around a place or coordinates.',
  adjust_camera_zoom:
    'Zoom the current camera view in or out by a small, medium or large amount.',
  zoom_to_globe:
    'Return the camera to a full-Earth globe view.',
  set_layer_visibility:
    'Enable or disable a real God\'s Eye View data layer such as flights, military, earthquakes, satellites, traffic, CCTV, radio, vessels, fires or infrastructure.',
  show_data_layers_menu:
    'Open the data-layers interface, optionally focused on a specific layer.',
  set_panel_open:
    'Open or close a God\'s Eye View UI panel.',
  set_context_mode:
    'Switch the right-side context mode between contacts, space missions or off.',
  control_cockpit:
    'Enter, exit or navigate the aircraft/vessel/site cockpit and contact context.',
  set_visual_style:
    'Change the globe visual style such as normal, surveillance, thermal, noir or snow.',
  get_entity_context:
    'Read structured context about the selected or visible map entities.',
  get_current_view_state:
    'Read the current camera, selected entity, layers and relevant visible-map state before reasoning about the scene.',
  set_hud:
    'Show, hide or reconfigure the intelligence HUD.',
  set_detection:
    'Enable, disable or tune the map detection overlay.',
  set_map_stack:
    'Change the basemap or 3D map source stack.',
  set_post_processing:
    'Enable or tune bloom and sharpening post-processing.',
  control_scene:
    'List, play, stop, advance or inspect saved scene sequences.',
  control_cctv:
    'Operate public CCTV cameras: enable, disable, choose, move to nearest, focus, show coverage/viewshed, adjust projection or autohop.',
  control_radio:
    'Operate internet radio: enable, select, play, pause, stop, change station/category/location or volume.',
  track_entity:
    'Find and start tracking a named or identified map entity.',
  stop_tracking:
    'Stop tracking the currently followed map entity.',
  frame_overhead:
    'Frame a group of flights, military aircraft, satellites or vessels from overhead.',
  annotate_map:
    'Draw persistent or temporary pins, labels, areas, arrows, highlights or routes on the map.',
  clear_annotations:
    'Remove map annotations.',
  move_camera:
    'Orbit, pan, tilt, rotate or stop continuous camera movement.',
  fly_route:
    'Animate/fly an already prepared route on the globe.',
  analyst_query:
    'Query loaded geospatial data such as flights, vessels, fires, earthquakes or infrastructure with filters and scope.',
  next_iss_pass:
    'Calculate the next ISS pass for coordinates or the current relevant location.',
});

function functionDeclarations() {
  return GEV_ACTION_SCHEMAS.map(({ name, parameters }) => ({
    name,
    description:
      ACTION_DESCRIPTIONS[name] ||
      `God's Eye View action: ${name.replaceAll('_', ' ')}`,
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

async function parseSocketJson(data) {
  try {
    if (typeof data === 'string') return JSON.parse(data);
    if (data instanceof Blob) return JSON.parse(await data.text());
    if (data instanceof ArrayBuffer)
      return JSON.parse(new TextDecoder().decode(data));
    if (ArrayBuffer.isView(data))
      return JSON.parse(
        new TextDecoder().decode(
          new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
        ),
      );
  } catch {}
  return null;
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
    const onMessage = async (event) => {
      const message = await parseSocketJson(event.data);
      if (!message) return;
      if (message.setupComplete) finish(resolve);
      else if (message.error)
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
    if (!calls.length) return;
    emit({
      type: 'state',
      state: 'executing',
      detail:
        calls.length === 1
          ? `Gemini: executing ${calls[0].name}`
          : `Gemini: executing ${calls.length} map actions`,
    });
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
    emit({ type: 'state', state: 'listening', detail: 'Gemini Live ready' });
  }

  async function handleMessage(event) {
    const message = await parseSocketJson(event.data);
    if (!message) return;

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
                model,
                generationConfig: {
                  responseModalities: ['AUDIO'],
                  speechConfig: {
                    voiceConfig: {
                      prebuiltVoiceConfig: {
                        voiceName: 'Puck',
                      },
                    },
                  },
                },
                inputAudioTranscription: {},
                outputAudioTranscription: {},
                systemInstruction: {
                  parts: [
                    {
                      text:
                        "You are the voice operator for God's Eye View. Speak briefly in the user's language. You control the actual globe through the available function tools. When the user asks to move, search, inspect, enable, disable, select, track, draw, route, measure, change a visual mode, use CCTV, radio, cockpit, layers, HUD, detection, scenes, map stacks, flights, ships, satellites, fires or other map capabilities, call the appropriate tool instead of merely describing what to do. For arbitrary place names or addresses use fly_to_location with query. For requests such as 'find security cameras in/near X', first navigate to X when needed, enable the cctv layer with set_layer_visibility, then use control_cctv with nearest/select/focus as appropriate. For nearest aircraft use select_nearest_aircraft. For ships use the ais-live-vessels layer. For requests about the current scene or visible data, use get_current_view_state, get_entity_context or analyst_query when appropriate. You may call multiple tools in sequence. Never say an action succeeded until its tool response confirms it. If a tool reports unavailable data, explain that briefly rather than inventing results.",
                    },
                  ],
                },
                tools: [{ functionDeclarations: functionDeclarations() }],
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
    emit({ type: 'state', state: 'connecting', detail: 'Gemini: requesting token' });
    const credential = await requestToken(startSignal);
    emit({ type: 'state', state: 'connecting', detail: 'Gemini: opening Live socket' });
    await openSocket(credential, startSignal);
    setupReady = true;
    emit({ type: 'state', state: 'connecting', detail: 'Gemini: setup complete, starting microphone' });
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
