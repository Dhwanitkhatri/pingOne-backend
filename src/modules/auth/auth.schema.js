// ============================================================
// Zod schemas for auth request bodies.
// ============================================================

import { z } from 'zod';

const password = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(72, 'Password must be at most 72 characters'); // bcrypt truncates beyond 72 bytes

export const registerSchema = z.object({
  firstName: z.string().trim().min(1, 'First name is required').max(100),
  lastName: z.string().trim().min(1, 'Last name is required').max(100),
  email: z.string().trim().toLowerCase().email('A valid email is required').max(255),
  password,
});

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('A valid email is required'),
  password: z.string().min(1, 'Password is required'),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1, 'refreshToken is required'),
});

export const forgotPasswordSchema = z.object({
  email: z.string().trim().toLowerCase().email('A valid email is required'),
});

export const resetPasswordSchema = z.object({
  token: z.string().trim().min(1, 'token is required'),
  password, // same strength rules as registration
});
