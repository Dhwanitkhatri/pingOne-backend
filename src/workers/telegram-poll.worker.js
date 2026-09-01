// ============================================================
// Telegram long-polling worker — the LOCAL-DEVELOPMENT stand-in for
// POST /webhooks/telegram.
//
// Why this exists:
//
// Telegram delivers a bot's updates exactly one way at a time. Either you
// register a webhook and Telegram POSTs to it, or you don't and you pull them
// yourself with getUpdates. A webhook needs a public HTTPS origin — Telegram
// flatly refuses localhost and plain http — so on a dev machine without a
// tunnel there is no webhook, no updates arrive, and the single thing the
// whole Telegram flow depends on never happens: capturing a contact's
// numeric chat_id when they press Start (see utils/telegramLink.js). Every
// send then fails with TELEGRAM_NOT_LINKED, which looks like a bug in the
// send path and isn't.
//
// So this polls instead. Updates go through the SAME handleTelegramEvent()
// the webhook controller calls — there is no second copy of the linking or
// engagement logic, and nothing here changes how production behaves.
//
// Two things worth knowing:
//
//   * Updates Telegram couldn't deliver are QUEUED for ~24h. The first poll
//     drains that backlog, so contacts who already pressed Start get linked
//     retroactively without being asked to do it again.
//   * getUpdates and a webhook are mutually exclusive. If a webhook is
//     registered, Telegram answers getUpdates with 409 Conflict. That's the
//     correct outcome, not a failure — this worker stands down for that bot
//     and lets the webhook do its job.
// ============================================================

import { prisma } from '../config/prisma.js';
import { decryptToken } from '../utils/crypto.js';
import { getPlatformId } from '../utils/platforms.js';
import { telegramModeOf, TELEGRAM_MODES } from '../platforms/telegram.adapter.js';
import { handleTelegramEvent } from '../modules/webhooks/webhooks.service.js';

const API_BASE = 'https://api.telegram.org';

/**
 * Seconds Telegram holds an empty getUpdates open before answering. This is
 * the whole point of long polling: one request per 25s of idle time rather
 * than a busy loop, and an update arrives the instant it's sent.
 */
const LONG_POLL_SECONDS = 25;

/** Abort a poll that outlives its long-poll window — a hung socket, usually. */
const REQUEST_TIMEOUT_MS = (LONG_POLL_SECONDS + 10) * 1000;

/** How often the set of connected bots is re-read from the database. */
const CREDENTIAL_REFRESH_MS = 60_000;

/** Backoff after a network error, so a flapping connection doesn't spin. */
const ERROR_BACKOFF_MS = 5_000;

/**
 * Only the update types this app acts on. Passing them explicitly also tells
 * Telegram to drop the rest server-side instead of shipping them to us.
 */
const ALLOWED_UPDATES = ['message', 'edited_message', 'my_chat_member'];

/** token -> loop state. Keyed by token so one bot shared by several users is polled once. */
const loops = new Map();

let refreshTimer = null;
let running = false;

// ---- lifecycle ------------------------------------------------------

/**
 * Begin polling every connected Telegram bot. Idempotent.
 *
 * Returns immediately; the loops run in the background.
 */
export function startTelegramPollWorker() {
  if (running) return;
  running = true;

  console.log('[telegram:poll] starting — local stand-in for the Telegram webhook');

  refreshCredentials().catch((err) =>
    console.error(`[telegram:poll] could not load bot credentials: ${err.message}`)
  );

  refreshTimer = setInterval(() => {
    refreshCredentials().catch((err) =>
      console.error(`[telegram:poll] credential refresh failed: ${err.message}`)
    );
  }, CREDENTIAL_REFRESH_MS);

  // Don't hold the process open on this timer alone.
  refreshTimer.unref?.();
}

/**
 * Stop every loop. In-flight long polls are aborted rather than waited on —
 * an abandoned getUpdates has no side effects, because an update is only
 * consumed once the NEXT call acknowledges it via `offset`.
 */
export function stopTelegramPollWorker() {
  if (!running) return;
  running = false;

  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;

  for (const state of loops.values()) {
    state.stopped = true;
    state.controller?.abort();
  }
  loops.clear();

  console.log('[telegram:poll] stopped');
}

// ---- credentials ----------------------------------------------------

/**
 * Read the connected bot tokens and start a loop for any that's new.
 *
 * Deduplicated by token: several users can connect the SAME bot (this is
 * normal in a shared dev database), and getUpdates is per-bot, not per-user.
 * Polling one bot twice would make the two callers steal each other's updates
 * — whichever polled first would acknowledge them and the other would never
 * see them.
 */
async function refreshCredentials() {
  const platformId = await getPlatformId('telegram');

  const credentials = await prisma.userPlatformCredential.findMany({
    where: { platformId, isActive: true },
    select: { userId: true, encryptedToken: true, tokenIv: true, extraInfo: true },
  });

  const tokens = new Map(); // token -> a label for logs

  for (const credential of credentials) {
    // User-account (MTProto) credentials hold a session string, not a bot
    // token. They have no getUpdates and need no linking — skip them.
    if (telegramModeOf(credential) === TELEGRAM_MODES.USER) continue;

    let token;
    try {
      token = decryptToken(credential.encryptedToken, credential.tokenIv);
    } catch (err) {
      // Almost always a TOKEN_ENCRYPTION_KEY that changed since the row was
      // written. Nothing this worker can do; the send path reports it too.
      console.warn(
        `[telegram:poll] skipping user ${credential.userId}: token could not be decrypted (${err.message})`
      );
      continue;
    }

    if (!tokens.has(token)) {
      tokens.set(token, credential.extraInfo?.bot_username ?? `bot ${credential.extraInfo?.bot_id ?? '?'}`);
    }
  }

  // Drop loops whose bot was disconnected.
  for (const [token, state] of loops) {
    if (!tokens.has(token)) {
      state.stopped = true;
      state.controller?.abort();
      loops.delete(token);
      console.log(`[telegram:poll] ${state.label} disconnected — polling stopped`);
    }
  }

  // Start loops for newly connected bots.
  for (const [token, label] of tokens) {
    if (loops.has(token)) continue;

    const state = { label, offset: 0, stopped: false, controller: null };
    loops.set(token, state);
    console.log(`[telegram:poll] polling ${label}`);
    void pollLoop(token, state);
  }

  if (loops.size === 0) {
    console.log('[telegram:poll] no Telegram bot is connected yet — nothing to poll');
  }
}

// ---- the loop -------------------------------------------------------

async function pollLoop(token, state) {
  while (state.stopped === false && running) {
    let updates;

    try {
      updates = await getUpdates(token, state);
    } catch (err) {
      if (state.stopped) return;

      // A conflicting webhook is a configuration answer, not an error to
      // retry — polling must not fight a webhook for the same updates.
      if (err.code === 'WEBHOOK_ACTIVE') {
        console.log(
          `[telegram:poll] ${state.label} has a webhook registered — polling stands down (the webhook receives updates)`
        );
        loops.delete(token);
        return;
      }

      if (err.code === 'UNAUTHORIZED') {
        console.error(
          `[telegram:poll] ${state.label} rejected the bot token — reconnect the bot in Settings. Polling stopped.`
        );
        loops.delete(token);
        return;
      }

      console.warn(`[telegram:poll] ${state.label}: ${err.message} — retrying in ${ERROR_BACKOFF_MS / 1000}s`);
      await delay(ERROR_BACKOFF_MS);
      continue;
    }

    for (const update of updates) {
      // `offset` is the acknowledgement: advancing past an update tells
      // Telegram to drop it. Do that only AFTER the handler has run, so a
      // crash mid-handler leaves the update to be redelivered.
      try {
        const summary = await handleTelegramEvent(update);
        console.log(
          `[telegram:poll] update ${update.update_id} processed=${summary.processed} ignored=${summary.ignored} unmatched=${summary.unmatched}`
        );
      } catch (err) {
        // One malformed update must not stall the queue behind it forever —
        // it would be redelivered on every poll and block everything newer.
        console.error(`[telegram:poll] update ${update.update_id} failed: ${err.message}`);
      }

      state.offset = update.update_id + 1;
    }
  }
}

/**
 * One long-poll round trip.
 * @returns {Promise<object[]>} updates, oldest first
 */
async function getUpdates(token, state) {
  state.controller = new AbortController();
  const timeout = setTimeout(() => state.controller.abort(), REQUEST_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(`${API_BASE}/bot${token}/getUpdates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        offset: state.offset || undefined,
        timeout: LONG_POLL_SECONDS,
        allowed_updates: ALLOWED_UPDATES,
      }),
      signal: state.controller.signal,
    });
  } catch (err) {
    if (state.stopped) return [];
    // Keep the original as `cause`: the message alone loses the stack and the
    // error code (ECONNREFUSED vs. a TLS failure vs. an abort), which is
    // exactly what you want when polling starts failing in production.
    throw new Error(`getUpdates request failed (${err.message})`, { cause: err });
  } finally {
    clearTimeout(timeout);
    state.controller = null;
  }

  const data = await res.json();

  if (!data.ok) {
    const description = data.description ?? `HTTP ${res.status}`;

    if (res.status === 409 || /webhook is active/i.test(description)) {
      throw Object.assign(new Error(description), { code: 'WEBHOOK_ACTIVE' });
    }
    if (res.status === 401) {
      throw Object.assign(new Error(description), { code: 'UNAUTHORIZED' });
    }
    throw new Error(`getUpdates failed: ${description}`);
  }

  return data.result ?? [];
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
