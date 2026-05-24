/**
 * Start a challenge session for an agent.
 *
 * Usage:
 *   npx tsx scripts/start-challenge.ts --agent-id=<uuid> --start=5 --target=50 --days=30 --mode=paper
 */
import 'dotenv/config';
import { prisma } from '../lib/prisma';
import { startChallenge } from '../challenge';

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const arg of argv) {
    const m = arg.match(/^--([^=]+)=(.+)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const agentId = args['agent-id'];
  if (!agentId) {
    console.error('Missing --agent-id=<uuid>');
    process.exit(1);
  }

  const startingCapital = parseFloat(args.start ?? '5');
  const targetCapital   = parseFloat(args.target ?? '50');
  const durationDays    = parseInt(args.days ?? '30', 10);
  const executionMode   = (args.mode ?? 'paper') as 'paper' | 'live';
  const maxDrawdownPct  = args['max-dd'] ? parseFloat(args['max-dd']) : 1.0;
  const riskPercent     = args['risk-pct'] ? parseFloat(args['risk-pct']) : undefined;
  const leverage        = args.leverage ? parseFloat(args.leverage) : undefined;

  if (executionMode !== 'paper' && executionMode !== 'live') {
    console.error('--mode must be paper or live');
    process.exit(1);
  }

  const agent = await prisma.agent.findUnique({ where: { id: agentId } });
  if (!agent) {
    console.error(`Agent not found: ${agentId}`);
    process.exit(1);
  }

  const session = await startChallenge(agentId, {
    startingCapital,
    targetCapital,
    durationDays,
    executionMode,
    maxDrawdownPct,
    riskPercent,
    leverage,
  });

  console.log('Challenge started:');
  console.log(JSON.stringify({
    id:              session.id,
    agentId:         session.agentId,
    startingCapital: session.startingCapital,
    targetCapital:   session.targetCapital,
    endsAt:          session.endsAt.toISOString(),
    executionMode:   session.executionMode,
  }, null, 2));

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
