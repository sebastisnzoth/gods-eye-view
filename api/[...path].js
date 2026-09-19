import { localProviderPlugins } from '../server/providers/local.js';
import { apiNotFoundPlugin } from '../server/standalone/api-not-found.js';

const SERVERLESS_EXCLUDED_PLUGINS = new Set([
  // AISStream is a persistent WebSocket feed. Vercel Functions are stateless
  // and cannot own the long-lived socket/watchdog that the local server uses.
  'ais-live-proxy',
  // Provider Settings writes local configuration and restarts the local Vite
  // server. Neither behavior belongs in an immutable production deployment.
  'gev-key-setup',
]);

function createMiddlewareRegistry() {
  const stack = [];
  return {
    stack,
    use(route, handler) {
      if (typeof route === 'function') {
        handler = route;
        route = '/';
      }
      if (typeof handler !== 'function') return;
      stack.push({ route: String(route || '/'), handler });
    },
  };
}

function installViteProviderPlugins() {
  const registry = createMiddlewareRegistry();
  const server = {
    middlewares: registry,
    // Providers may register optional close hooks in local Vite. There is no
    // long-lived HTTP server inside a Vercel Function.
    httpServer: null,
  };

  for (const plugin of localProviderPlugins()) {
    if (!plugin || SERVERLESS_EXCLUDED_PLUGINS.has(plugin.name)) continue;
    const install = plugin.configureServer || plugin.configurePreviewServer;
    if (typeof install === 'function') install(server);
  }

  apiNotFoundPlugin().configureServer(server);
  return registry.stack;
}

const middlewareStack = installViteProviderPlugins();

function routeMatches(pathname, mount) {
  if (mount === '/' || mount === '') return true;
  return pathname === mount || pathname.startsWith(`${mount}/`);
}

function stripMount(url, mount) {
  if (mount === '/' || mount === '') return url || '/';
  const raw = String(url || '/');
  const stripped = raw.slice(mount.length);
  if (!stripped) return '/';
  if (stripped.startsWith('?')) return `/${stripped}`;
  return stripped.startsWith('/') ? stripped : `/${stripped}`;
}

function invokeMiddleware(handler, req, res, next) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      res.off?.('finish', finish);
      res.off?.('close', finish);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const continueStack = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      Promise.resolve(next(error)).then(resolve, reject);
    };

    res.once?.('finish', finish);
    res.once?.('close', finish);

    try {
      const result = handler(req, res, continueStack);
      Promise.resolve(result).catch((error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      });
    } catch (error) {
      settled = true;
      cleanup();
      reject(error);
    }
  });
}

async function runStack(req, res, index = 0) {
  if (res.writableEnded) return;
  const originalUrl = String(req.url || '/');
  const pathname = new URL(originalUrl, 'http://localhost').pathname;

  for (let i = index; i < middlewareStack.length; i += 1) {
    const entry = middlewareStack[i];
    if (!routeMatches(pathname, entry.route)) continue;

    req.url = stripMount(originalUrl, entry.route);
    try {
      await invokeMiddleware(entry.handler, req, res, (error) => {
        req.url = originalUrl;
        if (error) throw error;
        return runStack(req, res, i + 1);
      });
    } finally {
      req.url = originalUrl;
    }
    return;
  }

  if (!res.writableEnded) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({ error: 'Unknown API route' }));
  }
}

export const config = {
  maxDuration: 30,
};

export default async function handler(req, res) {
  const pathname = new URL(req.url || '/', 'http://localhost').pathname;

  if (pathname === '/api/ais-live' || pathname.startsWith('/api/ais-live/')) {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.end(
      JSON.stringify({
        error:
          'AIS live streaming requires the long-lived local server and is not available on stateless Vercel Functions.',
        rows: [],
        status: 'unavailable',
      }),
    );
    return;
  }

  try {
    await runStack(req, res);
  } catch (error) {
    console.error('[Vercel API adapter]', error);
    if (res.writableEnded) return;
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({ error: 'Internal API error' }));
  }
}
