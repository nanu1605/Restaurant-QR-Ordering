'use client';

import { Search } from 'lucide-react';
import { useId, useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

import { lookupEmailSends } from '../actions';
import type { EmailRow } from '../system';
import { EmailRows } from './parts';

/**
 * The emails to one address (docs/DECISIONS.md SA-87): sent to the server
 * by a form post, never in the URL, and hashed there.
 */
export function EmailLookup() {
  const id = useId();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ email: string; rows: EmailRow[] } | null>(null);

  // onSubmit, not a form action: an action would clear the address afterwards.
  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const email = String(new FormData(event.currentTarget).get('email') ?? '');
    startTransition(async () => {
      const found = await lookupEmailSends(email);
      if (!found.ok) {
        setError(found.fieldErrors?.email ?? found.error);
        setResult(null);
        return;
      }
      setError(null);
      setResult({ email: email.trim(), rows: found.data });
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <form method="post" onSubmit={submit} className="flex flex-col gap-1.5" noValidate>
        <Label htmlFor={`${id}-email`}>Emails to one address</Label>
        <div className="flex flex-wrap gap-2">
          <Input
            id={`${id}-email`}
            name="email"
            type="email"
            autoComplete="off"
            className="max-w-xs"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${id}-error` : `${id}-hint`}
          />
          <Button type="submit" variant="outline" disabled={pending}>
            <Search aria-hidden />
            {pending ? 'Looking…' : 'Look up'}
          </Button>
        </div>
        {error ? (
          <p id={`${id}-error`} role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : (
          <p id={`${id}-hint`} className="text-xs text-ink-muted">
            The latest 20 in the last 30 days, newest first.
          </p>
        )}
      </form>
      <div aria-live="polite">
        {result &&
          (result.rows.length === 0 ? (
            <p className="text-sm text-ink-muted">
              No emails to {result.email} in the last 30 days.
            </p>
          ) : (
            <EmailRows rows={result.rows} label={`Emails to ${result.email}`} />
          ))}
      </div>
    </div>
  );
}
