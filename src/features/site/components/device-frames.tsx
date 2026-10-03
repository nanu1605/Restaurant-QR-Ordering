import { cn } from 'cn';

/**
 * Drawn devices for the website's product scenes. The screens inside are
 * simplified renders of the real app, so they stay sharp at any size.
 */

type FrameProps = {
  children: React.ReactNode;
  className?: string;
  /** Overrides on the screen, e.g. a fixed height instead of the aspect ratio. */
  screenClassName?: string;
};

export function PhoneFrame({ children, className, screenClassName }: FrameProps) {
  return (
    <div className={cn('rounded-[1.75rem] bg-ink p-[5px] shadow-2xl shadow-ink/25', className)}>
      <div
        className={cn(
          'relative flex aspect-[9/19] flex-col overflow-hidden rounded-[1.45rem] bg-paper',
          screenClassName,
        )}
      >
        <div className="absolute top-1.5 left-1/2 z-10 h-1.5 w-1/4 -translate-x-1/2 rounded-full bg-ink" />
        {children}
      </div>
    </div>
  );
}

export function TabletFrame({ children, className, screenClassName }: FrameProps) {
  return (
    <div className={cn('rounded-[1.25rem] bg-ink p-[7px] shadow-2xl shadow-ink/20', className)}>
      <div
        className={cn(
          'relative flex aspect-[4/3] flex-col overflow-hidden rounded-[0.8rem] bg-paper',
          screenClassName,
        )}
      >
        {children}
      </div>
    </div>
  );
}

export function LaptopFrame({ children, className, screenClassName }: FrameProps) {
  return (
    <div className={cn('flex flex-col items-center', className)}>
      <div className="w-full rounded-t-[0.9rem] bg-ink p-[6px] pb-[9px] shadow-2xl shadow-ink/20">
        <div
          className={cn(
            'relative flex aspect-[16/10] flex-col overflow-hidden rounded-[0.35rem] bg-paper',
            screenClassName,
          )}
        >
          {children}
        </div>
      </div>
      <div className="relative h-3 w-[112%] rounded-b-xl bg-[#c5cbd4]">
        <div className="absolute top-0 left-1/2 h-1.5 w-1/6 -translate-x-1/2 rounded-b-md bg-[#aab1bc]" />
      </div>
    </div>
  );
}
