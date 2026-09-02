import type { ReactNode, HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

/** Card primitive — mirrors shadcn/ui Card's API but hand-rolled so the app has no external
 *  component dependency. Solid neutral-900 with a soft border on the trading-desk dark theme. */
export function Card({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('rounded-lg border border-neutral-800 bg-neutral-900/70 shadow-sm', className)} {...rest}>
      {children}
    </div>
  );
}
export function CardHeader({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('border-b border-neutral-800 px-4 py-3 text-sm font-medium', className)}>{children}</div>;
}
export function CardBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('px-4 py-3', className)}>{children}</div>;
}
