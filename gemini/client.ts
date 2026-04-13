import Anthropic from '@anthropic-ai/sdk';
import logger from '../utils/logger';
import { ClaudeCallOptions, ClaudeCallResult, ClaudeModel, EntrySignal, ManagementDecision, PostMortemResult, TokenUsage } from '../types/claude.types';


// ─────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────

const MODEL_SONNET: ClaudeModel = 'claude-sonnet-4-5';
const MODEL_HAIKU: ClaudeModel = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 1024;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

// Cost per token in USD (approximate)
const COST = {
    [MODEL_SONNET]: { input: 0.000003, output: 0.000015 },
    [MODEL_HAIKU]: { input: 0.00000025, output: 0.00000125 },
};

// ─────────────────────────────────────────────
// Anthropic client singleton
// ─────────────────────────────────────────────

const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
});

// ─────────────────────────────────────────────
// Public — entry signal
// Uses Sonnet — needs strong reasoning
// ─────────────────────────────────────────────

export async function getEntrySignal(
    systemPrompt: string,
    entryPrompt: string,
    agentId: string,
): Promise<ClaudeCallResult<EntrySignal>> {
    return callClaude<EntrySignal>({
        systemPrompt,
        userPrompt: entryPrompt,
        options: {
            model: MODEL_SONNET,
            promptType: 'entry',
            agentId,
            useCache: true,
        },
    });
}

// ─────────────────────────────────────────────
// Public — management decision
// Uses Haiku for HOLD checks (cheap)
// Escalates to Sonnet if adjustment needed
// ─────────────────────────────────────────────

export async function getManagementDecision(
    systemPrompt: string,
    managementPrompt: string,
    agentId: string,
): Promise<ClaudeCallResult<ManagementDecision>> {
    // First pass with Haiku — cheap check
    const haikuResult = await callClaude<ManagementDecision>({
        systemPrompt,
        userPrompt: managementPrompt,
        options: {
            model: MODEL_HAIKU,
            promptType: 'management',
            agentId,
            useCache: true,
        },
    });

    // If Haiku says HOLD — trust it, don't escalate
    if (haikuResult.success && haikuResult.data?.action === 'HOLD') {
        return haikuResult;
    }

    // Haiku wants to adjust or close — escalate to Sonnet for better judgment
    logger.info('Escalating management decision to Sonnet', { agentId });

    return callClaude<ManagementDecision>({
        systemPrompt,
        userPrompt: managementPrompt,
        options: {
            model: MODEL_SONNET,
            promptType: 'management',
            agentId,
            useCache: true,
        },
    });
}

// ─────────────────────────────────────────────
// Public — post-mortem analysis
// Uses Sonnet — quality matters here
// ─────────────────────────────────────────────

export async function getPostMortem(
    postMortemPrompt: string,
    agentId: string,
): Promise<ClaudeCallResult<PostMortemResult>> {
    return callClaude<PostMortemResult>({
        systemPrompt: POST_MORTEM_SYSTEM,
        userPrompt: postMortemPrompt,
        options: {
            model: MODEL_SONNET,
            promptType: 'postmortem',
            agentId,
            useCache: false, // post-mortems are infrequent — not worth caching
        },
    });
}

// ─────────────────────────────────────────────
// Public — lesson synthesis (weekly job)
// ─────────────────────────────────────────────

export async function getSynthesis(
    synthesisPrompt: string,
    agentId: string,
): Promise<ClaudeCallResult<{ rules: any[] }>> {
    return callClaude<{ rules: any[] }>({
        systemPrompt: POST_MORTEM_SYSTEM,
        userPrompt: synthesisPrompt,
        options: {
            model: MODEL_SONNET,
            promptType: 'synthesis',
            agentId,
            useCache: false,
        },
    });
}

// ─────────────────────────────────────────────
// Core caller — all public functions go through here
// Handles retries, parsing, token tracking, errors
// ─────────────────────────────────────────────

async function callClaude<T>({
    systemPrompt,
    userPrompt,
    options,
}: {
    systemPrompt: string;
    userPrompt: string;
    options: ClaudeCallOptions;
}): Promise<ClaudeCallResult<T>> {
    const startedAt = Date.now();
    let lastError: string | null = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const response = await anthropic.messages.create({
                model: options.model,
                max_tokens: MAX_TOKENS,
                system: options.useCache
                    ? [
                        {
                            type: 'text',
                            text: systemPrompt,
                            cache_control: { type: 'ephemeral' }, // 90% cheaper on repeat calls
                        },
                    ]
                    : systemPrompt,
                messages: [
                    { role: 'user', content: userPrompt },
                ],
            });

            const rawText = response.content
                .filter(b => b.type === 'text')
                .map(b => (b as any).text)
                .join('');

            const tokenUsage = calculateTokenUsage(options.model, response.usage);

            logger.info('Claude call completed', {
                agentId: options.agentId,
                promptType: options.promptType,
                model: options.model,
                tokens: tokenUsage,
                durationMs: Date.now() - startedAt,
            });

            // Parse JSON response
            const parsed = parseJSON<T>(rawText);

            if (!parsed.success) {
                logger.warn('Claude returned invalid JSON', {
                    agentId: options.agentId,
                    promptType: options.promptType,
                    raw: rawText.slice(0, 200),
                });

                // Retry on parse failure
                lastError = `JSON parse failed: ${parsed.error}`;
                if (attempt < MAX_RETRIES) {
                    await sleep(RETRY_DELAY_MS * attempt);
                    continue;
                }
            }

            return {
                success: parsed.success,
                data: parsed.data,
                rawResponse: rawText,
                tokensUsed: tokenUsage,
                error: parsed.error,
                durationMs: Date.now() - startedAt,
            };

        } catch (error: any) {
            lastError = error?.message ?? 'Unknown error';

            logger.warn(`Claude API attempt ${attempt} failed`, {
                agentId: options.agentId,
                promptType: options.promptType,
                error: lastError,
            });

            // Don't retry on auth errors — they won't fix themselves
            if (error?.status === 401 || error?.status === 403) {
                break;
            }

            if (attempt < MAX_RETRIES) {
                await sleep(RETRY_DELAY_MS * attempt);
            }
        }
    }

    // All retries exhausted
    logger.error('Claude call failed after all retries', {
        agentId: options.agentId,
        promptType: options.promptType,
        error: lastError,
    });

    return {
        success: false,
        data: null,
        rawResponse: '',
        tokensUsed: { inputTokens: 0, outputTokens: 0, cacheHits: 0, totalCost: 0 },
        error: lastError,
        durationMs: Date.now() - startedAt,
    };
}

// ─────────────────────────────────────────────
// JSON parser — Claude sometimes wraps in ```json
// This handles both clean JSON and wrapped versions
// ─────────────────────────────────────────────

function parseJSON<T>(raw: string): { success: boolean; data: T | null; error: string | null } {
    try {
        // Strip markdown code fences if present
        const cleaned = raw
            .replace(/^```json\s*/i, '')
            .replace(/^```\s*/i, '')
            .replace(/\s*```$/i, '')
            .trim();

        const data = JSON.parse(cleaned) as T;
        return { success: true, data, error: null };
    } catch (e: any) {
        return { success: false, data: null, error: e.message };
    }
}

// ─────────────────────────────────────────────
// Token cost calculator
// ─────────────────────────────────────────────

function calculateTokenUsage(model: ClaudeModel, usage: any): TokenUsage {
    const rates = COST[model];
    const input = usage.input_tokens ?? 0;
    const output = usage.output_tokens ?? 0;
    const cacheHits = usage.cache_read_input_tokens ?? 0;

    // Cache hits cost 10% of normal input price
    const inputCost = (input - cacheHits) * rates.input + cacheHits * rates.input * 0.1;
    const outputCost = output * rates.output;

    return {
        inputTokens: input,
        outputTokens: output,
        cacheHits,
        totalCost: Math.round((inputCost + outputCost) * 10_000) / 10_000,
    };
}

// ─────────────────────────────────────────────
// Minimal system prompt for post-mortem calls
// These don't need trading rules — just analysis
// ─────────────────────────────────────────────

const POST_MORTEM_SYSTEM = `
You are a trading performance analyst.
Your job is to objectively analyse losing trades and identify patterns.
Always respond in valid JSON only — no prose, no markdown.
Be specific and actionable — vague analysis is useless.
`.trim();

// ─────────────────────────────────────────────
// Util
// ─────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}