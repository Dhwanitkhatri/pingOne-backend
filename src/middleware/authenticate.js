// ============================================================
// JWT route guards.
//
//   authenticate         — required. 401s unless a valid Bearer access
//                          token maps to a live, active user.
//   optionalAuthenticate — best-effort. Populates req.user when a valid
//                          token is present, otherwise continues as an
//                          anonymous request. Used by endpoints that
//                          work either way (e.g. logout, which only
//                          needs the refresh token but can do more when
//                          it knows who is calling).
//
// Both resolve the user from the database on every request rather than
// trusting the token's claims, so deactivating or deleting an account
// takes effect immediately instead of at token expiry.
// ============================================================

import { verifyAccessToken } from '../utils/token.js';
import { prisma } from '../config/prisma.js';
import { AppError } from '../utils/AppError.js';

// `role` is resolved here, on every request, rather than read off the token —
// so revoking an operator's back-office rights takes effect on their very next
// call instead of at token expiry. middleware/authorize.js reads it.
const userSelect = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  isVerified: true,
  role: true,
};

/** Pull the Bearer token out of the Authorization header, if any. */
function bearerToken(req) {
  const [scheme, token] = (req.headers.authorization ?? '').split(' ');
  return scheme === 'Bearer' && token ? token : null;
}

export async function authenticate(
  req,
  res,
  next,
  { findActiveUser = (args) => prisma.user.findFirst(args) } = {}
) {
  try {
    const token = bearerToken(req);
    if (!token) {
      throw AppError.unauthorized('Missing Bearer token', { code: 'NO_TOKEN' });
    }

    const payload = verifyAccessToken(token);

    const user = await findActiveUser({
      where: { id: payload.sub, isActive: true, deletedAt: null },
      select: userSelect,
    });

    if (!user) {
      throw AppError.unauthorized('User no longer exists or is inactive', {
        code: 'USER_INACTIVE',
      });
    }

    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

export async function optionalAuthenticate(req, res, next) {
  try {
    const token = bearerToken(req);
    if (!token) return next();

    // A malformed/expired token is not an error here — the request simply
    // stays anonymous.
    let payload;
    try {
      payload = verifyAccessToken(token);
    } catch {
      return next();
    }

    req.user =
      (await prisma.user.findFirst({
        where: { id: payload.sub, isActive: true, deletedAt: null },
        select: userSelect,
      })) ?? undefined;

    next();
  } catch (err) {
    next(err);
  }
}
