import { useState, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

/** Minimal controlled tab pane. Caller passes labels; onChange fires with the active key. */
export interface Tab { key: string; label: string; content: ReactNode }
export function Tabs({ tabs, initial }: { tabs: Tab[]; initial?: string }) {
  const [active, setActive] = useState(initial ?? tabs[0]?.key ?? '');
  const current = tabs.find((t) => t.key === active) ?? tabs[0];
  return (
    <div>
      <div role="tablist" className="flex gap-1 border-b border-neutral-800 text-sm">
        {tabs.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={t.key === active}
            className={cn(
              'px-3 py-2 -mb-px border-b-2 border-transparent transition-colors',
              t.key === active ? 'border-accent text-accent' : 'text-neutral-400 hover:text-neutral-100',
            )}
            onClick={() => setActive(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="pt-4">{current?.content ?? null}</div>
    </div>
  );
}
