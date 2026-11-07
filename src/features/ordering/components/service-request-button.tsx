'use client';

import { BellRing, ReceiptText } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { isUnrecognizedAction } from '@/features/new-version/stale';

import { requestService } from '../actions';
import { useStrings } from './lang-provider';

type ServiceRequestButtonProps = {
  qrToken: string;
  type: 'call_waiter' | 'request_bill';
  className?: string;
};

/**
 * Call a waiter or ask for the bill (spec §8.7, P9-1). After a tap it says so;
 * tapping again (or from another phone) never calls twice.
 */
export function ServiceRequestButton({ qrToken, type, className }: ServiceRequestButtonProps) {
  const [state, setState] = useState<'idle' | 'pending' | 'sent'>('idle');
  const t = useStrings();
  const labels = t.service[type];
  const Icon = type === 'call_waiter' ? BellRing : ReceiptText;

  async function send() {
    setState('pending');
    try {
      const result = await requestService(qrToken, type);
      if (result.ok) {
        setState('sent');
        toast.success(labels.toast);
        return;
      }
      toast.error(result.error);
    } catch (error) {
      // An older build: the refresh notice explains (docs/DECISIONS.md VPS-8).
      if (!isUnrecognizedAction(error)) toast.error(t.networkError);
    }
    setState('idle');
  }

  return (
    <Button
      variant="outline"
      size="touch"
      className={className}
      disabled={state === 'pending'}
      aria-live="polite"
      onClick={send}
    >
      <Icon aria-hidden />
      {state === 'sent' ? labels.sent : labels.idle}
    </Button>
  );
}
