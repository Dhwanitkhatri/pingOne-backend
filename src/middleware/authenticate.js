// ============================================================
// authenticate — protects routes with a Bearer access token.
// Verifies the JWT, loads the (live, active) user, and attaches a
// minimal user object to req.user. Reject if the token is missing,
// invalid, or the user no longer exists / was deactivated / deleted.
// ============================================================

import { verifyAccessToken } from '../utils/token.js';
import { prisma } from '../config/prisma.js';
import { AppError } from '../utils/AppError.js';

export async function authenticate(req, res, next) {
  try {
    const header = req.headers.authorization ?? '';
    const [scheme, token] = header.split(' ');

    if (scheme !== 'Bearer' || !token) {
      throw AppError.unauthorized('Missing Bearer token', { code: 'NO_TOKEN' });
    }

    const payload = verifyAccessToken(token);

    const user = await prisma.user.findFirst({
      where: { id: payload.sub, isActive: true, deletedAt: null },
      select: { id: true, email: true, firstName: true, lastName: true, isVerified: true },
    });

    if (!user) {
      throw AppError.unauthorized('User no longer exists or is inactive', { code: 'USER_INACTIVE' });
    }

    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}
