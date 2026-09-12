import { z } from 'zod';

import { STAFF_LOGIN_ROLES } from '@/lib/auth/roles';
import { USERNAME_PATTERN } from '@/lib/auth/staff-email';

/** Staff logins forms (spec §9.5, §13.3), shared by the dialogs and the server actions. */

export const displayNameSchema = z
  .string()
  .trim()
  .min(1, 'Enter a name.')
  .max(80, 'Use 80 characters or fewer.');

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(USERNAME_PATTERN, 'Use 3–30 lowercase letters, numbers or underscores.');

// Supabase Auth hashes with bcrypt, which only reads the first 72 bytes.
export const passwordSchema = z
  .string()
  .min(8, 'Use at least 8 characters.')
  .max(72, 'Use 72 characters or fewer.');

export const staffRoleSchema = z.enum(STAFF_LOGIN_ROLES, { message: 'Choose a role.' });

export const newStaffSchema = z.object({
  displayName: displayNameSchema,
  username: usernameSchema,
  role: staffRoleSchema,
  password: passwordSchema,
});
export type NewStaff = z.input<typeof newStaffSchema>;

export const editStaffSchema = z.object({
  displayName: displayNameSchema,
  role: staffRoleSchema,
});
export type EditStaff = z.input<typeof editStaffSchema>;

export const resetPasswordSchema = z.object({ password: passwordSchema });
export type ResetPassword = z.input<typeof resetPasswordSchema>;
