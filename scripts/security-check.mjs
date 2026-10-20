import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const files = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard'],
  { encoding: 'utf8' },
)
  .trim()
  .split('\n');
const violations = [];
for (const file of files) {
  if (/^\.env(?:\.|$)/.test(file) && file !== '.env.example')
    violations.push(`${file}: local environment must be ignored`);
  if (/\.(dump|pem|key)$/.test(file))
    violations.push(`${file}: private/generated artifact`);
  if (!/\.(ts|tsx|js|mjs|json|md|yml|yaml|sql|example|txt)$/.test(file))
    continue;
  const body = readFileSync(file, 'utf8');
  if (/^[A-Za-z0-9_-]{43}\s*$/.test(body))
    violations.push(`${file}: possible raw bearer token file`);
  if (/\b[0-9]{6,12}:[A-Za-z0-9_-]{30,}\b/.test(body))
    violations.push(`${file}: possible hard-coded Telegram credential`);
  if (
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(body) &&
    file !== 'scripts/security-check.mjs'
  )
    violations.push(`${file}: private key material`);
  if (
    /(?:api\.bybit\.com|api-testnet\.bybit\.com)\/v5\/(?:order|position|account)\//.test(
      body,
    )
  )
    violations.push(
      `${file}: authenticated exchange execution path is outside the PAPER milestone`,
    );
  if (
    /^packages\/(runtime|risk|strategies)\//.test(file) &&
    /(?:from|import\()[^\n]*notifications|api\.telegram\.org/.test(body)
  )
    violations.push(`${file}: Telegram dependency on critical trading path`);
}
if (violations.length) {
  console.error(violations.join('\n'));
  process.exit(1);
}
console.log(
  'Tracked artifact hygiene, PAPER-only exchange boundary and notification dependency checks passed',
);
