import { z } from 'zod';

export const registerSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(320),
    name: z.string().trim().min(1).max(120),
    // Length is the property that actually matters; complexity rules mostly
    // push people towards shorter, more predictable passwords.
    password: z.string().min(12, 'Password must be at least 12 characters').max(200),
  })
  .strict();

export const loginSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(320),
    password: z.string().min(1).max(200),
  })
  .strict();
