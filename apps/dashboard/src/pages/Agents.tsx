import { Link, useParams } from 'react-router-dom';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Skeleton } from '@/components/ui/Skeleton';
import { Table, Thead, Th, Tbody, Tr, Td } from '@/components/ui/Table';
import { Tabs } from '@/components/ui/Tabs';
import { useAgent, useAgents } from '@/hooks/useAgents';
import { AgentTabs } from '@/components/AgentTabs';
import { CreateAgentForm } from '@/components/CreateAgentForm';
import { SeedBrainButton, useSeedingStatuses } from '@/components/SeedBrainButton';
import { useState } from 'react';

export function Agents() {
  const { id } = useParams();
  if (id) return <AgentDetail id={id} />;
  return <AgentsList />;
}

function AgentsList() {
  const q = useAgents();
  const seeding = useSeedingStatuses();
  const [showCreate, setShowCreate] = useState(false);
  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold">Trading Agents</h1>
        {!showCreate && (
          <button onClick={() => setShowCreate(true)}
            className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-neutral-950 hover:bg-cyan-300">
            + Create Agent
          </button>
        )}
      </div>
      {showCreate && <div className="mb-4"><CreateAgentForm onClose={() => setShowCreate(false)} /></div>}
      {q.isLoading ? <Skeleton className="h-40" />
       : q.isError ? <p className="text-red-300">API error: {(q.error as { message?: string }).message}</p>
       : (
        <Card>
          <Table>
            <Thead>
              <Tr>
                <Th>Name</Th><Th>Domain</Th><Th>Style</Th><Th>Config v.</Th><Th>Universe</Th><Th>Status</Th><Th>Brain</Th>
              </Tr>
            </Thead>
            <Tbody>
              {(q.data ?? []).map((a) => (
                <Tr key={a.id}>
                  <Td><Link className="text-accent hover:underline" to={`/agents/${a.id}`}>{a.name}</Link></Td>
                  <Td><Badge tone={a.domain === 'perp' ? 'info' : 'warn'}>{a.domain}</Badge></Td>
                  <Td>{a.tradingStyle}</Td>
                  <Td className="tabular-nums">v{a.activeConfigVersion}</Td>
                  <Td className="text-neutral-400">{a.universe.join(', ')}</Td>
                  <Td><Badge tone={a.status === 'active' ? 'success' : 'neutral'}>{a.status}</Badge></Td>
                  <Td><SeedBrainButton agentId={a.id} domain={a.domain} status={seeding.data?.statuses[a.id]} /></Td>
                </Tr>
              ))}
              {(q.data ?? []).length === 0 && (
                <Tr><Td className="text-neutral-500" colSpan={7}>No agents yet — create one via <code>POST /trading-agents</code>.</Td></Tr>
              )}
            </Tbody>
          </Table>
        </Card>
       )}
    </div>
  );
}

function AgentDetail({ id }: { id: string }) {
  const q = useAgent(id);
  if (q.isLoading) return <Skeleton className="h-40" />;
  if (q.isError) return <p className="text-red-300">API error: {(q.error as { message?: string }).message}</p>;
  if (!q.data) return <p className="text-neutral-500">Agent not found.</p>;
  const a = q.data;
  return (
    <div>
      <div className="mb-4 flex items-center gap-3">
        <Link to="/agents" className="text-sm text-neutral-400 hover:text-neutral-100">← Agents</Link>
        <h1 className="text-lg font-semibold">{a.name}</h1>
        <Badge tone={a.domain === 'perp' ? 'info' : 'warn'}>{a.domain}</Badge>
        <Badge tone="neutral">{a.tradingStyle}</Badge>
        <Badge tone="neutral">v{a.activeConfigVersion}</Badge>
      </div>
      <AgentTabs agent={a} />
    </div>
  );
}

// Small local shims so AgentsList's Tabs/Tbody aren't undefined — kept out of the top of the file
// so the imports read clean.
// (AgentTabs.tsx uses Tabs component; this file uses DataTable's Tbody.)
void Tabs; void CardBody; void CardHeader;
