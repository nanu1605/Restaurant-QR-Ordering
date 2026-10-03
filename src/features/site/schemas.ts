import { z } from 'zod';

/** Ten digits, without spaces, +91 or a leading 0 ("+91 98765-43210" → "9876543210"). */
export function normalizePhone(text: string): string {
  const digits = text.replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1);
  return digits;
}

const text = (field: string, max: number) =>
  z.string().trim().min(1, `Enter ${field}.`).max(max, `Use ${max} characters or fewer.`);

/** The "Book a demo" form (docs/DECISIONS.md W-6); site_leads checks the same. */
export const leadSchema = z.object({
  name: text('your name', 80),
  restaurantName: text('your restaurant’s name', 120),
  city: text('your city', 60),
  phone: z
    .string()
    .transform(normalizePhone)
    .pipe(z.string().regex(/^[0-9]{10}$/, 'Enter a 10-digit mobile number.')),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(254, 'Use 254 characters or fewer.')
    .pipe(z.union([z.literal(''), z.email('Enter a valid email address, or leave it empty.')]))
    .transform((value) => value || null),
  planCode: z.string().transform((value) => (/^[a-z_]{2,30}$/.test(value) ? value : null)),
  message: z
    .string()
    // Forms send line breaks as CRLF; the textarea counted each as one character.
    .transform((value) => value.replace(/\r\n?/g, '\n'))
    .pipe(z.string().trim().max(1000, 'Use 1000 characters or fewer.'))
    .transform((value) => value || null),
});

export type LeadInput = z.input<typeof leadSchema>;
export type Lead = z.output<typeof leadSchema>;
