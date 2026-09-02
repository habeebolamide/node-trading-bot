import { cn } from '@/lib/cn';

const tones = {
  neutral: 'bg-neutral-800 text-neutral-200',
  success: 'bg-emerald-900/70 text-emerald-200',
  danger:  'bg-red-900/70 text-red-200',
  warn:    'bg-amber-900/70 text-amber-200',
  info:    'bg-cyan-900/70 text-cyan-200',
} as const;
export type BadgeTone = keyof typeof tones;

export function Badge({ tone = 'neutral', children }: { tone?: BadgeTone; children: React.ReactNode }) {
  return <span className={cn('rounded-md px-1.5 py-0.5 text-xs font-medium', tones[tone])}>{children}</span>;
}
