import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { useAgentRoom, type RoomEvent } from '@/hooks/useAgentRoom';
import { fmtTime } from '@/lib/format';

/** §27 live activity feed. Each row IS a real event (§27 verbatim: "every displayed claim
 *  should map to real system events/data"). No synthesized narrative — the LLM's job is
 *  the Judge's thesis, not the Agent Room's timeline. */
export function AgentRoom({ limit = 100 }: { limit?: number }) {
  const { events, connected } = useAgentRoom({ limit });
  return (
    <Card>
      <CardHeader className="flex items-center justify-between">
        <span>Agent Room · live activity feed (§27)</span>
        <Badge tone={connected ? 'success' : 'warn'}>{connected ? 'live' : 'reconnecting'}</Badge>
      </CardHeader>
      <CardBody>
        {events.length === 0 && <div className="text-sm text-neutral-500">No events yet — pipeline is quiet or the workers haven't emitted anything since the tab opened.</div>}
        <ul className="max-h-96 divide-y divide-neutral-900 overflow-auto">
          {events.map((e, i) => <li key={`${e.eventTime}-${i}`} className="py-2"><RoomRow ev={e} /></li>)}
        </ul>
      </CardBody>
    </Card>
  );
}

function RoomRow({ ev }: { ev: RoomEvent }) {
  const label = SOURCE_LABEL[ev.source] ?? ev.source;
  const tone: 'info' | 'success' | 'warn' | 'danger' | 'neutral' =
    ev.type.includes('invalidated') ? 'danger' :
    ev.type.includes('resolved')    ? 'success' :
    ev.type.includes('judge')       ? 'info'    :
    ev.type.includes('created')     ? 'info'    : 'neutral';
  return (
    <div className="grid grid-cols-[10rem_1fr_10rem] items-center gap-2 text-xs">
      <div className="text-neutral-500 tabular-nums">{fmtTime(ev.eventTime)}</div>
      <div className="flex items-center gap-2">
        <Badge tone={tone}>{ev.type}</Badge>
        <span className="text-neutral-300">{summarize(ev)}</span>
      </div>
      <div className="text-right text-neutral-500">{label}</div>
    </div>
  );
}

const SOURCE_LABEL: Record<string, string> = {
  'signal-engine': 'Signal Engine',
  'judge': 'Judge',
  'override-gate': 'Override Gate',
  'risk-agent': 'Risk',
  'seed-brain': 'Seeding',
};

function summarize(ev: RoomEvent): string {
  const p = ev.payload as Record<string, unknown>;
  if (typeof p?.symbol === 'string') return `${p.symbol} — ${(p.direction as string) ?? ''}`;
  if (typeof p?.signalId === 'string') return `signal ${(p.signalId as string).slice(0, 8)}…`;
  return '';
}
