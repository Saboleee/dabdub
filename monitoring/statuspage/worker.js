/**
 * Cloudflare Worker — status.cheesepay.xyz
 *
 * Routes:
 *   GET /          → serves the status page HTML (with API_BASE injected)
 *   GET /api/status → proxies GET https://api.cheesepay.xyz/health/admin
 *                     (avoids CORS issues; adds cache-control)
 *
 * Deploy:
 *   wrangler deploy
 *
 * Environment variables (set in wrangler.toml or Cloudflare dashboard):
 *   API_ORIGIN  = https://api.cheesepay.xyz   (no trailing slash)
 *   SOROBAN_RPC_URL = https://soroban-testnet.stellar.org (Soroban RPC endpoint)
 */

// ─── HTML is inlined at build time via wrangler's text_blobs or fetched ───────
// For simplicity we import it as a string. In wrangler.toml add:
//   [text_blobs]
//   STATUS_HTML = "index.html"
// Then reference it as STATUS_HTML below.
// If you prefer, replace with a fetch to your CDN.

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ── Proxy: /api/status → upstream /health/admin ──────────────────────────
    if (url.pathname === '/api/status') {
      return proxyHealthAdmin(env);
    }

    // ── Status page HTML ──────────────────────────────────────────────────────
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return serveStatusPage(env);
    }

    // ── Favicon (prevent 404 noise) ───────────────────────────────────────────
    if (url.pathname === '/favicon.ico') {
      return new Response(null, { status: 204 });
    }

    return new Response('Not found', { status: 404 });
  },
};

// ─── Proxy /health/admin ──────────────────────────────────────────────────────
async function proxyHealthAdmin(env) {
  const apiOrigin = env.API_ORIGIN ?? 'https://api.cheesepay.xyz';

  let upstreamRes;
  try {
    upstreamRes = await fetch(`${apiOrigin}/health/admin`, {
      headers: { Accept: 'application/json' },
      // Cloudflare fetch timeout is 30s by default
    });
  } catch (err) {
    // Network-level failure — API is unreachable
    return jsonResponse(
      {
        status: 'down',
        timestamp: new Date().toISOString(),
        components: {
          database:   { status: 'down', latency: 0 },
          stellar:    { status: 'down', latency: 0 },
          partnerApi: { status: 'down', latency: 0 },
          redis:      { status: 'down', latency: 0 },
          queue:      { status: 'down', latency: 0 },
        },
        error: 'API unreachable',
      },
      503,
    );
  }

  // Parse body regardless of status code (/health/admin returns 503 with body
  // when critical components are down)
  let body;
  try {
    body = await upstreamRes.json();
  } catch {
    body = { status: 'down', timestamp: new Date().toISOString(), error: 'Invalid response' };
  }

  // ── Soroban-specific health checks ────────────────────────────────────────
  // Run in parallel; each check is isolated so one failure never breaks the
  // rest of the status payload.
  const [sorobanRpc, escrowIndexer, feeCalculator] = await Promise.all([
    checkSorobanRpc(env),
    checkEscrowIndexer(apiOrigin),
    checkFeeCalculator(apiOrigin),
  ]);

  const components = {
    ...(body && typeof body === 'object' && body.components ? body.components : {}),
    sorobanRpc,
    escrowIndexer,
    feeCalculator,
  };

  // Degrade overall status if any Soroban check is down.
  const sorobanDown = [sorobanRpc, escrowIndexer, feeCalculator].some(
    (c) => c.status === 'down',
  );
  const overallStatus = sorobanDown ? 'degraded' : (body?.status ?? 'up');

  const merged = {
    ...(body && typeof body === 'object' ? body : {}),
    status: overallStatus,
    timestamp: body?.timestamp ?? new Date().toISOString(),
    components,
  };

  return jsonResponse(merged, upstreamRes.status, {
    // Cache for 30 seconds at the edge — status page polls every 60s so this
    // halves upstream load while keeping data fresh enough.
    'Cache-Control': 'public, max-age=30, s-maxage=30',
  });
}

// ─── Soroban RPC response time check ──────────────────────────────────────────
async function checkSorobanRpc(env) {
  const rpcUrl = env.SOROBAN_RPC_URL ?? 'https://soroban-testnet.stellar.org';
  const start = Date.now();
  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth', params: {} }),
    });
    const latency = Date.now() - start;
    if (!res.ok) {
      return { status: 'down', latency, error: `HTTP ${res.status}` };
    }
    const data = await res.json();
    const healthy = data?.result?.status === 'healthy';
    return {
      status: healthy ? 'up' : 'degraded',
      latency,
      ...(healthy ? {} : { error: data?.result?.status ?? 'unhealthy' }),
    };
  } catch (err) {
    return { status: 'down', latency: Date.now() - start, error: 'RPC unreachable' };
  }
}

// ─── Last payment_escrow event indexed within 30s ─────────────────────────────
async function checkEscrowIndexer(apiOrigin) {
  const MAX_AGE_MS = 30_000;
  try {
    const res = await fetch(`${apiOrigin}/health/indexer`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      return { status: 'down', lastEventAgeMs: null, error: `HTTP ${res.status}` };
    }
    const data = await res.json();
    const lastEventAt = data?.lastPaymentEscrowEventAt;
    if (!lastEventAt) {
      return { status: 'down', lastEventAgeMs: null, error: 'No payment_escrow event indexed' };
    }
    const ageMs = Date.now() - new Date(lastEventAt).getTime();
    return {
      status: ageMs <= MAX_AGE_MS ? 'up' : 'degraded',
      lastEventAgeMs: ageMs,
      ...(ageMs <= MAX_AGE_MS ? {} : { error: 'payment_escrow event stale (>30s)' }),
    };
  } catch (err) {
    return { status: 'down', lastEventAgeMs: null, error: 'Indexer unreachable' };
  }
}

// ─── fee_calculator returns valid fee for test merchant ───────────────────────
async function checkFeeCalculator(apiOrigin) {
  try {
    const res = await fetch(`${apiOrigin}/health/fee-calculator`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      return { status: 'down', error: `HTTP ${res.status}` };
    }
    const data = await res.json();
    const fee = data?.fee;
    const valid = typeof fee === 'number' && Number.isFinite(fee) && fee >= 0;
    return {
      status: valid ? 'up' : 'down',
      ...(valid ? { fee } : { error: 'Invalid fee for test merchant' }),
    };
  } catch (err) {
    return { status: 'down', error: 'Fee calculator unreachable' };
  }
}

// ─── Serve status page HTML ───────────────────────────────────────────────────
async function serveStatusPage(env) {
  // STATUS_HTML is bound as a text blob in wrangler.toml.
  // Fallback: fetch from the same worker's origin (useful in local dev).
  const html = typeof STATUS_HTML !== 'undefined'
    ? STATUS_HTML
    : await fetchFallbackHtml();

  // Inject the API base so the page calls /api/status (this worker's proxy)
  // instead of the real API directly — avoids CORS entirely.
  const injected = html.replace(
    "window.__API_BASE__ || 'https://api.cheesepay.xyz'",
    "window.__API_BASE__ || ''",  // empty string → relative URL /api/status
  ).replace(
    "`${API_BASE}/health/admin`",
    "`${API_BASE}/api/status`",
  );

  return new Response(injected, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=60',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    },
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      ...extraHeaders,
    },
  });
}

async function fetchFallbackHtml() {
  // Only used in local wrangler dev when text_blobs aren't available
  return '<html><body>Status page loading...</body></html>';
}
