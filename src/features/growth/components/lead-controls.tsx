'use client';

import { Mail, MessageCircle, Phone } from 'lucide-react';
import { useId, useState, useTransition } from 'react';
import { toast } from 'sonner';

import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatMobile, telHref, whatsappHref } from '@/features/platform/dues-messages';
import { ChoiceMenu } from '@/features/support/components/request-controls';

import { updateLead, type LeadPatch } from '../actions';
import {
  fromIndiaInput,
  LEAD_STAGE_LABELS,
  LEAD_STAGES,
  LOST_REASON_LABELS,
  LOST_REASONS,
  toIndiaInput,
  type LeadStage,
  type LostReason,
} from '../leads';

const NONE = 'none';

// Lost is chosen with its reason, so the menu holds one entry for each.
const STAGE_OPTIONS: [string, string][] = [
  ...LEAD_STAGES.filter((stage) => stage !== 'lost').map((stage): [string, string] => [
    stage,
    LEAD_STAGE_LABELS[stage],
  ]),
  ...LOST_REASONS.map((reason): [string, string] => [
    `lost:${reason}`,
    `Lost: ${LOST_REASON_LABELS[reason].toLowerCase()}`,
  ]),
];

/** Stage (Lost with why) and who is on it (docs/DECISIONS.md SA-55). */
export function LeadControls({
  leadId,
  stage,
  lostReason,
  assigneeId,
  team,
}: {
  leadId: string;
  stage: LeadStage;
  lostReason: LostReason | null;
  assigneeId: string | null;
  team: { user_id: string; email: string }[];
}) {
  return (
    <div className="flex flex-wrap gap-2">
      <ChoiceMenu
        label="Stage"
        value={stage === 'lost' ? `lost:${lostReason}` : stage}
        options={STAGE_OPTIONS}
        onChoose={(next) => {
          const [chosen, reason] = next.split(':') as [LeadStage, LostReason | undefined];
          return updateLead(
            leadId,
            reason ? { stage: chosen, lost_reason: reason } : { stage: chosen },
          );
        }}
      />
      <ChoiceMenu
        label="Assignee"
        value={assigneeId ?? NONE}
        options={[
          [NONE, 'No one'],
          ...(assigneeId && !team.some((member) => member.user_id === assigneeId)
            ? [[assigneeId, 'A former team member'] as [string, string]]
            : []),
          ...team.map((member): [string, string] => [member.user_id, member.email]),
        ]}
        onChoose={(next) => updateLead(leadId, { assignee: next === NONE ? null : next })}
      />
    </div>
  );
}

/** The next follow-up or the demo, India time; saved or cleared here. */
export function LeadTimeField({
  leadId,
  field,
  label,
  value,
}: {
  leadId: string;
  field: 'follow_up_at' | 'demo_at';
  label: string;
  value: string | null;
}) {
  const id = useId();
  const [text, setText] = useState(toIndiaInput(value));
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function save(next: string | null) {
    setError(null);
    startTransition(async () => {
      const result = await updateLead(leadId, { [field]: next } as LeadPatch);
      if (result.ok) {
        toast.success(next ? `${label} saved` : `${label} cleared`);
        if (!next) setText('');
      } else setError(result.error);
    });
  }

  return (
    <form
      className="flex flex-col gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        const at = fromIndiaInput(text);
        if (!at) setError('Choose a date and time.');
        else save(at);
      }}
    >
      <label htmlFor={`${id}-time`} className="text-sm font-medium text-ink">
        {label} <span className="font-normal text-ink-muted">(India time)</span>
      </label>
      <div className="flex flex-wrap gap-2">
        <Input
          id={`${id}-time`}
          type="datetime-local"
          value={text}
          onChange={(event) => setText(event.target.value)}
          aria-invalid={!!error}
          aria-describedby={error ? `${id}-error` : undefined}
          className="h-11 w-auto min-w-0 text-base md:h-9 md:text-sm"
        />
        <Button type="submit" variant="outline" size="touch" disabled={pending}>
          Save
        </Button>
        {value && (
          <Button
            type="button"
            variant="ghost"
            size="touch"
            disabled={pending}
            onClick={() => save(null)}
          >
            Clear
          </Button>
        )}
      </div>
      {error && (
        <p id={`${id}-error`} role="alert" className="text-sm font-medium text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}

/** Links the lead to a restaurant by its code, or unlinks it. */
export function LinkRestaurant({
  leadId,
  linked,
  suggestions,
}: {
  leadId: string;
  linked: { name: string } | null;
  suggestions: { slug: string; name: string }[];
}) {
  const id = useId();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function link(next: string | null) {
    setError(null);
    startTransition(async () => {
      const result = await updateLead(leadId, { restaurant_code: next });
      if (result.ok) {
        toast.success(next ? 'Linked' : 'Unlinked');
        setCode('');
      } else setError(result.error);
    });
  }

  if (linked) {
    return (
      <Button
        type="button"
        variant="outline"
        size="touch"
        disabled={pending}
        onClick={() => link(null)}
        className="w-fit"
      >
        Unlink {linked.name}
      </Button>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {suggestions.length > 0 && (
        <ul className="flex flex-col gap-2" aria-label="Restaurants with this mobile">
          {suggestions.map((restaurant) => (
            <li key={restaurant.slug} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-ink">
                {restaurant.name} <span className="text-ink-muted">({restaurant.slug})</span>
              </span>
              <Button
                type="button"
                variant="outline"
                className="h-11 md:h-8"
                disabled={pending}
                onClick={() => link(restaurant.slug)}
              >
                Link<span className="sr-only"> to {restaurant.name}</span>
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex flex-col gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          if (!code.trim()) setError('Enter the restaurant’s code.');
          else link(code);
        }}
      >
        <label htmlFor={`${id}-code`} className="text-sm font-medium text-ink">
          Restaurant code
        </label>
        <div className="flex flex-wrap gap-2">
          <Input
            id={`${id}-code`}
            value={code}
            onChange={(event) => setCode(event.target.value)}
            maxLength={60}
            autoComplete="off"
            aria-invalid={!!error}
            aria-describedby={error ? `${id}-error` : undefined}
            className="h-11 w-48 text-base md:h-9 md:text-sm"
          />
          <Button type="submit" variant="outline" size="touch" disabled={pending}>
            Link
          </Button>
        </div>
        {error && (
          <p id={`${id}-error`} role="alert" className="text-sm font-medium text-destructive">
            {error}
          </p>
        )}
      </form>
    </div>
  );
}

const contactClass = buttonVariants({ variant: 'outline', size: 'touch' });

/**
 * Call, WhatsApp and email. After a call or a WhatsApp to a new lead, asks
 * whether to mark it contacted (docs/DECISIONS.md SA-55).
 */
export function LeadContact({
  leadId,
  phone,
  email,
  stage,
}: {
  leadId: string;
  phone: string;
  email: string | null;
  stage: LeadStage;
}) {
  const [asking, setAsking] = useState(false);
  const [pending, startTransition] = useTransition();
  const tel = telHref(phone);
  const whatsapp = whatsappHref(phone, '');
  const ask = () => {
    if (stage === 'new') setAsking(true);
  };

  function markContacted() {
    startTransition(async () => {
      const result = await updateLead(leadId, { stage: 'contacted' });
      if (result.ok) {
        toast.success('Marked as contacted');
        setAsking(false);
      } else toast.error(result.error);
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-ink tabular-nums">+91 {formatMobile(phone) ?? phone}</p>
      <div className="flex flex-wrap gap-2">
        {tel && (
          <a href={tel} onClick={ask} className={contactClass}>
            <Phone aria-hidden />
            Call
          </a>
        )}
        {whatsapp && (
          <a
            href={whatsapp}
            target="_blank"
            rel="noopener noreferrer"
            onClick={ask}
            className={contactClass}
          >
            <MessageCircle aria-hidden />
            WhatsApp
          </a>
        )}
        {email && (
          <a href={`mailto:${email}`} className={contactClass}>
            <Mail aria-hidden />
            Email
          </a>
        )}
      </div>
      {asking && stage === 'new' && (
        <div
          role="status"
          className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-paper p-3"
        >
          <p className="text-sm font-medium text-ink">Mark as contacted?</p>
          <Button type="button" size="touch" disabled={pending} onClick={markContacted}>
            Mark as contacted
          </Button>
          <Button type="button" variant="ghost" size="touch" onClick={() => setAsking(false)}>
            Not now
          </Button>
        </div>
      )}
    </div>
  );
}
