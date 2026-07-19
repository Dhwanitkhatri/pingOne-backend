// ============================================================
// requestLogger — DEV-ONLY verbose HTTP logger.
//
// For every request it prints:
//   • the method, path, authenticated user id, status code, timing
//   • the request reconstructed as a copy-paste-able `curl` command
//   • the response body
//
// It is a no-op when NODE_ENV=production (safety net), and it is wired
// in app.js behind a single, clearly-marked line so you can remove it
// entirely when shipping to production.
//
// Secrets (passwords, tokens, Authorization header) are redacted by
// default. Flip LOG_SECRETS to true while debugging if you need the
// curl to be fully replayable against protected routes.
// ============================================================

import { isProd } from '../config/env.js';

// ---- configuration ------------------------------------------------
const LOG_SECRETS = false; // true = show real passwords/tokens (unsafe; debug only)
const MAX_BODY_CHARS = 2000; // truncate very long request/response bodies
const REDACT_KEYS = [
  'password',
  'currentpassword',
  'newpassword',
  'token',
  'accesstoken',
  'refreshtoken',
  'encryptedtoken',
  'token_iv',
  'tokeniv',
]; // matched case-insensitively at any depth
const CURL_HEADERS = ['content-type', 'authorization']; // headers included in the curl

// ---- tiny ANSI helpers (no dependency) ----------------------------
const paint = (code, s) => `\x1b[${code}m${s}\x1b[0m`;
const dim = (s) => paint(2, s);
const bold = (s) => paint(1, s);
const statusColor = (status) =>
  status >= 500 ? 31 : status >= 400 ? 33 : status >= 300 ? 36 : 32; // red/yellow/cyan/green

// ---- redaction ----------------------------------------------------
function redact(value) {
  if (LOG_SECRETS) return value;
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = REDACT_KEYS.includes(k.toLowerCase()) ? '***REDACTED***' : redact(v);
    }
    return out;
  }
  return value;
}

function maskAuthHeader(value) {
  if (LOG_SECRETS) return value;
  const [scheme] = value.split(' ');
  return scheme === 'Bearer' ? 'Bearer ***REDACTED***' : '***REDACTED***';
}

// ---- helpers ------------------------------------------------------
function safeStringify(payload) {
  if (payload === undefined || payload === null) return '';
  let str;
  if (typeof payload === 'string') str = payload;
  else if (Buffer.isBuffer(payload)) str = payload.toString('utf8');
  else {
    try {
      str = JSON.stringify(redact(payload));
    } catch {
      str = String(payload);
    }
  }
  return str.length > MAX_BODY_CHARS ? `${str.slice(0, MAX_BODY_CHARS)}… (${str.length} chars)` : str;
}

function buildCurl(req) {
  const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
  const lines = [`curl -X ${req.method} '${url}'`];

  for (const name of CURL_HEADERS) {
    const raw = req.headers[name];
    if (!raw) continue;
    const value = name === 'authorization' ? maskAuthHeader(raw) : raw;
    lines.push(`  -H '${name}: ${value}'`);
  }

  if (req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0) {
    lines.push(`  -d '${JSON.stringify(redact(req.body))}'`);
  }

  return lines.join(' \\\n');
}

// ---- middleware ---------------------------------------------------
export function requestLogger(req, res, next) {
  if (isProd) return next(); // safety net — never log verbosely in production

  const start = process.hrtime.bigint();

  // Capture whatever the handler ultimately sends back.
  let responseBody;
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    responseBody = body;
    return originalJson(body);
  };
  const originalSend = res.send.bind(res);
  res.send = (body) => {
    if (responseBody === undefined) responseBody = body;
    return originalSend(body);
  };

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    // req.user is populated by the authenticate middleware (runs before finish).
    const userId = req.user?.id ?? 'anonymous';
    const status = res.statusCode;

    const header =
      `${bold('▶')} ${bold(req.method)} ${req.originalUrl}  ` +
      `${dim(`user:${userId}`)}  →  ${paint(statusColor(status), bold(status))}  ` +
      `${dim(`(${durationMs.toFixed(1)}ms)`)}`;

    const body = safeStringify(responseBody);
    const responseLine = body ? `${dim('◀ response:')} ${body}` : dim('◀ (no body)');

    console.log(
      `\n${header}\n${dim(buildCurl(req))}\n${responseLine}`
    );
  });

  next();
}
