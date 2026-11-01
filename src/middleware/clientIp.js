// ============================================================
// The real client IP, as `req.ip`.
//
// On Render a request passes Cloudflare, then one or more internal load
// balancers, before reaching Node. `trust proxy: 1` only peels off the last
// hop, so `req.ip` came out as one of Render's own 10.x addresses — the
// admin audit log recorded those instead of the operator's IP, and every
// IP-keyed rate limiter lumped unrelated users together behind the same
// proxy.
//
// Cloudflare puts the visitor's address in CF-Connecting-IP and overwrites
// whatever a client sends in it, so it can be trusted as long as traffic
// arrives through Cloudflare (as it does on *.onrender.com). Locally the
// header is absent and Express's own `req.ip` is already right.
//
// Overriding `req.ip` itself, rather than adding a new field, means the
// audit log, session records and express-rate-limit all pick it up without
// each having to know about this.
// ============================================================

import net from 'node:net';

export function clientIp(req, res, next) {
  const forwarded = req.get('cf-connecting-ip') ?? req.get('true-client-ip');
  const ip = forwarded?.trim();

  if (ip && net.isIP(ip)) {
    Object.defineProperty(req, 'ip', { value: ip, configurable: true, enumerable: true });
  }
  next();
}
