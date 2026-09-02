import { describe, it, expect } from 'vitest';
import { JUDGE_PROMPTS, JUDGE_VERSION_CURRENT, currentJudgePrompt } from './prompts.js';

describe('JUDGE prompt registry', () => {
  it('JUDGE_VERSION_CURRENT maps to a registered prompt', () => {
    expect(JUDGE_PROMPTS[JUDGE_VERSION_CURRENT]).toBeDefined();
    expect(currentJudgePrompt().version).toBe(JUDGE_VERSION_CURRENT);
  });

  it('a prompt change bumps the version — reviewers see BOTH the old and the new', () => {
    // If someone edits v1 in place they violate the "never blend versions" rule. This assertion
    // pins the current prompt structure; a genuine change must add a new version alongside it.
    const v1 = JUDGE_PROMPTS[1]!;
    expect(v1.system).toContain('Judge');
    expect(v1.system).toContain('invalidator');
    expect(v1.system).toContain('Return ONLY a JSON object');
  });

  it('userTemplate embeds the evidence JSON', () => {
    const p = currentJudgePrompt();
    const evidence = {
      symbol: 'BTCUSDT' as const, domain: 'perp' as const,
      deterministic: { direction: 'LONG', compositeScore: 0.6, confidence: 0.7 },
      agents: [], historicalEdge: { evidence: 'INSUFFICIENT' as const, winRate: null, wilsonWidth: null, backoffDepth: 5 },
      risk: { level: 'LOW', flags: [] as readonly string[] },
    };
    const rendered = p.userTemplate(evidence);
    expect(rendered).toContain('BTCUSDT');
    expect(rendered).toContain('deterministic');
    expect(rendered).toContain('Return your judgment as JSON.');
  });
});
