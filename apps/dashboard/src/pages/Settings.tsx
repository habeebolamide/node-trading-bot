import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';
import { useAgents } from '@/hooks/useAgents';

/** Read-only Settings — displays each trading agent's active scoring_config as JSON. Editing
 *  config is CLI-only in MVP (rule 20 + rule 16 — a config change is a versioned event that
 *  should be reviewed like code). */
export function Settings() {
  const q = useAgents();
  return (
    <div>
      <h1 className="mb-4 text-lg font-semibold">Settings</h1>
      <p className="mb-4 text-sm text-neutral-500">
        The scoring config for each agent is displayed here. Editing is CLI-only:
        <code className="ml-1">PATCH /trading-agents/:id</code>. A promoted change is a NEW
        scoring_config row (rule 16); the old row stays queryable.
      </p>
      {q.isLoading ? <Skeleton className="h-40" /> : (
        <div className="space-y-3">
          {(q.data ?? []).map((a) => (
            <Card key={a.id}>
              <CardHeader>{a.name} · {a.domain} · v{a.activeConfigVersion}</CardHeader>
              <CardBody>
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs text-neutral-300">
{JSON.stringify(a.config, null, 2)}
                </pre>
              </CardBody>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
