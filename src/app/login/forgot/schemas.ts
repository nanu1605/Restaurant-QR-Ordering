import { z } from 'zod';

import { passwordRule } from '@/features/platform/schemas';
import { emailLoginSchema } from '@/lib/auth/schemas';

/** "Forgot password" (docs/DECISIONS.md P11-6): the email, then the code and the new password. */

export const resetRequestSchema = z.object({ email: emailLoginSchema.shape.email });

export const resetPasswordSchema = z
  .object({
    code: z
      .string()
      .transform((value) => value.replace(/\D/g, ''))
      .pipe(z.string().length(6, 'Enter the 6-digit code from the email.')),
    // Supabase Auth (bcrypt) reads 72 bytes, fewer characters outside English.
    password: passwordRule().refine(
      (password) => new TextEncoder().encode(password).length <= 72,
      'Use a shorter password.',
    ),
    confirm: z.string(),
  })
  .refine((input) => input.password === input.confirm, {
    path: ['confirm'],
    message: 'The passwords don’t match. Type the new password again.',
  });
