// ============================================================
// Zod schemas for auth request bodies.
// ============================================================

import { z } from 'zod';
import { emailString } from '../../utils/validators.js';

const password = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(72, 'Password must be at most 72 characters'); // bcrypt truncates beyond 72 bytes

export const signupSchema = z.object({
  firstName: z.string().trim().min(1, 'First name is required').max(100),
  lastName: z.string().trim().min(1, 'Last name is required').max(100),
  email: emailString,
  password,
});

export const loginSchema = z.object({
  email: emailString,
  password: z.string().min(1, 'Password is required'),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1, 'refreshToken is required'),
});

/**
 * Logout takes the refresh token to revoke. `allDevices` signs out every
 * session instead, which needs no specific token — but does need a valid
 * access token so we know whose sessions to kill.
 */
export const logoutSchema = z
  .object({
    refreshToken: z.string().min(1).optional(),
    allDevices: z.coerce.boolean().default(false),
  })
  .refine((data) => data.allDevices || Boolean(data.refreshToken), {
    message: 'refreshToken is required unless allDevices is true',
    path: ['refreshToken'],
  });

export const forgotPasswordSchema = z.object({
  email: emailString,
});

export const resetPasswordSchema = z.object({
  token: z.string().trim().min(1, 'token is required'),
  password, // same strength rules as signup
});

export const verifyEmailSchema = z.object({
  token: z.string().trim().min(1, 'token is required'),
});
