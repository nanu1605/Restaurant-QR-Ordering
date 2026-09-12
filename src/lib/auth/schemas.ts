import { z } from 'zod';

import { RESTAURANT_CODE_PATTERN, USERNAME_PATTERN } from './staff-email';

// Validation messages say what to do next (spec §13 writing style).
export const staffLoginSchema = z.object({
  restaurantCode: z
    .string()
    .trim()
    .toLowerCase()
    .regex(RESTAURANT_CODE_PATTERN, 'Enter your restaurant code.'),
  username: z.string().trim().toLowerCase().regex(USERNAME_PATTERN, 'Enter your username.'),
  password: z.string().min(1, 'Enter your password.').max(128),
});

export const emailLoginSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email('Enter a valid email address.')),
  password: z.string().min(1, 'Enter your password.').max(128),
});

export type StaffLoginInput = z.infer<typeof staffLoginSchema>;
export type EmailLoginInput = z.infer<typeof emailLoginSchema>;
