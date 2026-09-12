'use client';

import { useActionState, useId } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

import { signInWithEmail, signInWithUsername, type LoginFormState } from './actions';

type LoginFormProps = {
  next?: string;
  notice?: string;
};

export function LoginForm({ next, notice }: LoginFormProps) {
  const [staffState, staffAction, staffPending] = useActionState(signInWithUsername, null);
  const [emailState, emailAction, emailPending] = useActionState(signInWithEmail, null);

  return (
    <div className="flex flex-col gap-5">
      {notice && (
        <p
          role="status"
          className="rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink"
        >
          {notice}
        </p>
      )}

      <Tabs defaultValue="staff">
        <TabsList className="h-10 w-full">
          <TabsTrigger value="staff">Restaurant code</TabsTrigger>
          <TabsTrigger value="email">Email</TabsTrigger>
        </TabsList>

        <TabsContent value="staff">
          <form action={staffAction} className="flex flex-col gap-4 pt-3" noValidate>
            <input type="hidden" name="next" value={next ?? ''} />
            <Field
              name="restaurantCode"
              label="Restaurant code"
              autoComplete="organization"
              defaultValue={staffState?.values?.restaurantCode}
              error={staffState?.fieldErrors?.restaurantCode}
              autoCapitalize="none"
              spellCheck={false}
            />
            <Field
              name="username"
              label="Username"
              autoComplete="username"
              defaultValue={staffState?.values?.username}
              error={staffState?.fieldErrors?.username}
              autoCapitalize="none"
              spellCheck={false}
            />
            <Field
              name="password"
              label="Password"
              type="password"
              autoComplete="current-password"
              error={staffState?.fieldErrors?.password}
            />
            <FormError state={staffState} />
            <Button type="submit" size="touch" disabled={staffPending}>
              {staffPending ? 'Logging in…' : 'Log in'}
            </Button>
          </form>
        </TabsContent>

        <TabsContent value="email">
          <form action={emailAction} className="flex flex-col gap-4 pt-3" noValidate>
            <input type="hidden" name="next" value={next ?? ''} />
            <Field
              name="email"
              label="Email"
              type="email"
              autoComplete="email"
              defaultValue={emailState?.values?.email}
              error={emailState?.fieldErrors?.email}
              autoCapitalize="none"
              spellCheck={false}
            />
            <Field
              name="password"
              label="Password"
              type="password"
              autoComplete="current-password"
              error={emailState?.fieldErrors?.password}
            />
            <FormError state={emailState} />
            <Button type="submit" size="touch" disabled={emailPending}>
              {emailPending ? 'Logging in…' : 'Log in'}
            </Button>
          </form>
        </TabsContent>
      </Tabs>
    </div>
  );
}

type FieldProps = Omit<React.ComponentProps<'input'>, 'id'> & {
  name: string;
  label: string;
  error?: string;
};

function Field({ name, label, error, ...inputProps }: FieldProps) {
  const id = useId();
  const errorId = `${id}-error`;
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        name={name}
        className="h-11 text-base"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        {...inputProps}
      />
      {error && (
        <p id={errorId} className="text-sm text-status-void">
          {error}
        </p>
      )}
    </div>
  );
}

function FormError({ state }: { state: LoginFormState }) {
  if (!state?.error) return null;
  return (
    <p role="alert" className="text-sm font-medium text-status-void">
      {state.error}
    </p>
  );
}
