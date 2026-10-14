'use client';

import { ChevronDown, UserRound } from 'lucide-react';
import { useTransition } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

import { setAccountManager } from '../actions';
import type { TeamMember } from '../restaurant-page';

const NONE = 'none';

/** Who on the MenuMesh team looks after the restaurant (docs/DECISIONS.md SA-39). */
export function AccountManagerMenu({
  restaurantId,
  current,
  team,
}: {
  restaurantId: string;
  /** The account manager's user id. */
  current: { userId: string; email: string | null } | null;
  team: TeamMember[];
}) {
  const [pending, startTransition] = useTransition();

  function choose(value: string) {
    if (value === (current?.userId ?? NONE)) return;
    startTransition(async () => {
      const result = await setAccountManager(restaurantId, value === NONE ? null : value);
      if (result.ok)
        toast.success(value === NONE ? 'No account manager now' : 'Account manager set');
      else toast.error(result.error);
    });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" className="h-11 max-w-full md:h-8" />}>
        <UserRound aria-hidden />
        <span className="truncate">
          {pending
            ? 'Saving the account manager…'
            : `Account manager: ${current ? (current.email ?? 'a former team member') : 'none'}`}
        </span>
        <ChevronDown aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Account manager</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={current?.userId ?? NONE} onValueChange={choose}>
            <DropdownMenuRadioItem value={NONE} closeOnClick className="min-h-11 md:min-h-9">
              No one
            </DropdownMenuRadioItem>
            {team.map((member) => (
              <DropdownMenuRadioItem
                key={member.user_id}
                value={member.user_id}
                closeOnClick
                className="min-h-11 md:min-h-9"
              >
                {member.email}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
