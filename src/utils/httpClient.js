// ============================================================
// Minimal JSON HTTP helper for outbound calls to third-party providers
// (Google, Meta, Telegram). Uses the runtime's built-in fetch — no extra
// dependency — and normalises every failure into an AppError so a
// provider hiccup surfaces as a clean 502 instead of an unhandled crash.
// ============================================================

import { AppError } from './AppError.js';

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Perform a request and parse the JSON body.
 *
 * @param {string} url
 * @param {object} [options]
 * @param {string} [options.method='GET']
 * @param {Record<string,string>} [options.headers]
 * @param {URLSearchParams|string} [options.form]  form-encoded body
 * @param {unknown} [options.json]                 JSON body
 * @param {string} [options.provider='provider']   name used in error messages
 * @param {number} [options.timeoutMs]
 * @returns {Promise<any>} the parsed response body
 */
export async function fetchJson(url, options = {}) {
  const {
    method = 'GET',
    headers = {},
    form,
    json,
    provider = 'provider',
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;

  const requestHeaders = { Accept: 'application/json', ...headers };
  let body;

  if (form !== undefined) {
    body = form instanceof URLSearchParams ? form.toString() : form;
    requestHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
  } else if (json !== undefined) {
    body = JSON.stringify(json);
    requestHeaders['Content-Type'] = 'application/json';
  }

  // AbortSignal.timeout keeps a hung provider from holding the request open.
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: requestHeaders,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError';
    throw new AppError(502, `Could not reach ${provider}${timedOut ? ' (timed out)' : ''}`, {
      code: 'PROVIDER_UNREACHABLE',
      details: err.message,
    });
  }

  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text.slice(0, 500) };
    }
  }

  if (!response.ok) {
    throw new AppError(502, `${provider} rejected the request: ${describe(payload)}`, {
      code: 'PROVIDER_ERROR',
      details: { status: response.status, body: payload },
    });
  }

  return payload;
}

/** Pull a human-readable message out of a provider's error envelope. */
function describe(payload) {
  if (!payload) return 'no response body';
  return (
    payload.error?.message ??
    payload.error_description ??
    payload.description ?? // Telegram
    (typeof payload.error === 'string' ? payload.error : null) ??
    JSON.stringify(payload).slice(0, 200)
  );
}
