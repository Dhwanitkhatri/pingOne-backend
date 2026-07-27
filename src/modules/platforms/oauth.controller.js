// ============================================================
// OAuth controllers — the browser-facing half of platform connection.
//
// The two `start` endpoints are authenticated and answer with JSON by
// default: a single-page app cannot attach an Authorization header to a
// top-level redirect, so it reads `authorizationUrl` and navigates there
// itself. `?redirect=true` keeps the plain-302 behaviour for callers that
// can send the header (curl, server-side clients).
//
// The two `callback` endpoints are hit by the PROVIDER, so they are
// public and finish in the browser — they render a small page (or bounce
// to OAUTH_SUCCESS_REDIRECT) rather than returning an API payload.
// ============================================================

import * as oauthService from './oauth.service.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { env } from '../../config/env.js';

export const startGoogle = asyncHandler(async (req, res) => {
  const result = oauthService.startGoogle(req.user.id);
  respondWithAuthorizationUrl(req, res, result, 'gmail');
});

export const startMeta = asyncHandler(async (req, res) => {
  const result = oauthService.startMeta(req.user.id);
  respondWithAuthorizationUrl(req, res, result, 'whatsapp');
});

export const googleCallback = asyncHandler(async (req, res) => {
  await handleCallback(res, req.query, 'gmail', () =>
    oauthService.completeGoogle({ code: req.query.code, state: req.query.state })
  );
});

export const metaCallback = asyncHandler(async (req, res) => {
  await handleCallback(res, req.query, 'whatsapp', () =>
    oauthService.completeMeta({ code: req.query.code, state: req.query.state })
  );
});

// ---- helpers -------------------------------------------------------

function respondWithAuthorizationUrl(req, res, { authorizationUrl, state }, platform) {
  if (req.query.redirect) return res.redirect(302, authorizationUrl);

  res.status(200).json({
    platform,
    authorizationUrl,
    state,
    expiresInMinutes: env.OAUTH_STATE_TTL_MIN,
    message: 'Open authorizationUrl in the browser to grant access.',
  });
}

/**
 * Run a callback completion and render the outcome, converting a declined
 * consent screen or a failed exchange into a readable page instead of a
 * raw API error.
 */
async function handleCallback(res, query, platform, complete) {
  // The user pressed "Cancel" (or the provider refused before we were involved).
  const providerError = query.error ?? query.error_message;
  if (providerError) {
    return finish(res, 400, {
      platform,
      status: 'error',
      message:
        query.error_description ??
        query.error_message ??
        query.error_reason ??
        `Authorization was not completed (${providerError}).`,
    });
  }

  if (!query.code || !query.state) {
    return finish(res, 400, {
      platform,
      status: 'error',
      message: 'The provider redirect was missing its code or state parameter.',
    });
  }

  try {
    const result = await complete();
    return finish(res, 200, {
      platform: result.platform,
      status: 'connected',
      account: result.account ?? undefined,
      message: result.needsPhoneNumberId
        ? 'Connected, but no WhatsApp phone number was found — set phoneNumberId via POST /platforms/whatsapp before sending.'
        : 'Account connected. You can close this window.',
    });
  } catch (err) {
    return finish(res, err.statusCode ?? 502, {
      platform,
      status: 'error',
      message: err.isOperational ? err.message : 'Could not complete the connection.',
    });
  }
}

/** Bounce to the configured frontend URL, or render a standalone page. */
function finish(res, statusCode, result) {
  if (env.OAUTH_SUCCESS_REDIRECT) {
    const url = new URL(env.OAUTH_SUCCESS_REDIRECT);
    url.searchParams.set('platform', result.platform);
    url.searchParams.set('status', result.status);
    if (result.account) url.searchParams.set('account', result.account);
    if (result.status === 'error') url.searchParams.set('message', result.message);
    return res.redirect(302, url.toString());
  }

  const ok = result.status === 'connected';

  // helmet's default policy blocks the inline <style> below. Replace it for
  // this one response with a policy that is stricter in every other respect.
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");

  return res
    .status(statusCode)
    .type('html')
    .send(
      `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>PingOne — ${ok ? 'Connected' : 'Connection failed'}</title>
    <style>
      body { font-family: system-ui, -apple-system, Segoe UI, sans-serif; background: #0f172a;
             color: #e2e8f0; display: grid; place-items: center; min-height: 100vh; margin: 0; }
      .card { background: #1e293b; padding: 2.5rem 3rem; border-radius: 12px; max-width: 32rem;
              text-align: center; box-shadow: 0 10px 40px rgba(0,0,0,.4); }
      .icon { font-size: 3rem; }
      h1 { font-size: 1.25rem; margin: .75rem 0 .5rem; }
      p { color: #94a3b8; line-height: 1.6; margin: 0; }
      code { color: #38bdf8; }
    </style>
  </head>
  <body>
    <div class="card">
      <div class="icon">${ok ? '✅' : '⚠️'}</div>
      <h1>${ok ? `${escapeHtml(result.platform)} connected` : 'Connection failed'}</h1>
      <p>${escapeHtml(result.message)}</p>
      ${result.account ? `<p><code>${escapeHtml(result.account)}</code></p>` : ''}
    </div>
  </body>
</html>`
    );
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]
  );
}
