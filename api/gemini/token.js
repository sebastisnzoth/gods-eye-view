const TOKEN_ENDPOINT =
  'https://generativelanguage.googleapis.com/v1beta/auth_tokens';

function resolveGeminiApiKey() {
  return (
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_GEMINI_API_KEY ||
    process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
    process.env.GOOGLE_AI_API_KEY ||
    ''
  ).trim();
}

function resolveModel() {
  return String(process.env.GEMINI_LIVE_MODEL || 'gemini-3.8-live').trim();
}

export const config = {
  maxDuration: 15,
};

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.statusCode = 405;
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  const apiKey = resolveGeminiApiKey();
  if (!apiKey) {
    res.statusCode = 503;
    res.end(
      JSON.stringify({
        error:
          'Gemini API key is not configured. Set GEMINI_API_KEY in the deployment environment.',
      }),
    );
    return;
  }

  const model = resolveModel();
  const now = Date.now();
  const modelResource = model.startsWith('models/')
    ? model
    : `models/${model}`;
  const body = {
    uses: 1,
    expireTime: new Date(now + 30 * 60 * 1000).toISOString(),
    newSessionExpireTime: new Date(now + 60 * 1000).toISOString(),
    bidiGenerateContentSetup: {
      model: modelResource,
      generationConfig: {
        responseModalities: ['AUDIO'],
      },
      systemInstruction: {
        parts: [
          {
            text:
              "You are the voice interface for God's Eye View. Reply briefly in the user's language.",
          },
        ],
      },
    },
  };

  try {
    const response = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      signal: AbortSignal.timeout(12_000),
      headers: {
        'x-goog-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const data = await response.json().catch(() => null);
    if (!response.ok || typeof data?.name !== 'string' || !data.name) {
      const detail =
        data?.error?.message ||
        data?.error ||
        `Gemini token request failed: HTTP ${response.status}`;
      res.statusCode = response.ok ? 502 : response.status;
      res.end(JSON.stringify({ error: detail }));
      return;
    }

    res.statusCode = 200;
    res.end(
      JSON.stringify({
        token: data.name,
        model,
        expiresAt: data.expireTime || body.expireTime,
        newSessionExpiresAt:
          data.newSessionExpireTime || body.newSessionExpireTime,
      }),
    );
  } catch (error) {
    res.statusCode = 502;
    res.end(
      JSON.stringify({
        error: error?.message || 'Failed to create Gemini Live token',
      }),
    );
  }
}
