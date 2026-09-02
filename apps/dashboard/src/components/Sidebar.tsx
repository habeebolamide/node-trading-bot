import { NavLink } from 'react-router-dom';
import { cn } from '@/lib/cn';

/** Left navigation per §26. Nothing here writes; each item is a route. */
const NAV = [
  { to: '/', label: 'Overview' },
  { to: '/agents', label: 'Agents' },
  { to: '/signals', label: 'Signals' },
  { to: '/predictions', label: 'Predictions' },
  { to: '/portfolios', label: 'Portfolios' },
  { to: '/brain', label: 'Brain' },
  { to: '/performance', label: 'Performance' },
  { to: '/llm-review', label: 'LLM Review' },
  { to: '/tokens', label: 'Tokens' },
  { to: '/smart-money', label: 'Smart Money' },
  { to: '/settings', label: 'Settings' },
] as const;

export function Sidebar() {
  return (
    <aside className="w-56 shrink-0 border-r border-neutral-900 bg-neutral-950 px-3 py-4">
      <div className="mb-6 px-2 text-sm font-semibold uppercase tracking-wider text-accent">TIP</div>
      <nav className="flex flex-col gap-1">
        {NAV.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.to === '/'}
            className={({ isActive }) =>
              cn('rounded-md px-2 py-1.5 text-sm text-neutral-300 hover:bg-neutral-900 hover:text-neutral-100',
                 isActive && 'bg-neutral-900 text-accent')}
          >
            {n.label}
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}
