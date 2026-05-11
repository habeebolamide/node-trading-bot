import logger from '../utils/logger';
import type {
  EntrySignal,
  ManagementDecision,
  PostMortemResult,
  ClaudeCallResult,
} from '../types/claude.types';

// ─────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────

const OLLAMA_BASE_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434';

const MODELS = {
  entry:      process.env.OLLAMA_ENTRY_MODEL      ?? 'deepseek-r1:8b',
  management: process.env.OLLAMA_MANAGEMENT_MODEL ?? 'deepseek-r1:8b',
  postmortem: process.env.OLLAMA_POSTMORTEM_MODEL ?? 'deepseek-r1:8b',
  synthesis:  process.env.OLLAMA_SYNTHESIS_MODEL  ?? 'deepseek-r1:8b',
};

const MAX_RETRIES = 2;

// ─────────────────────────────────────────────
// Public API — same interface as before
// Nothing else in the codebase changes
// ─────────────────────────────────────────────

export function getEntrySignal(
  systemPrompt: string,
  entryPrompt:  string,
  agentId:      string,
): Promise<ClaudeCallResult<EntrySignal>> {
  return callOllama(systemPrompt, entryPrompt, 'entry', agentId, MODELS.entry);
}

export function getManagementDecision(
  systemPrompt:     string,
  managementPrompt: string,
  agentId:          string,
): Promise<ClaudeCallResult<ManagementDecision>> {
  return callOllama(systemPrompt, managementPrompt, 'management', agentId, MODELS.management);
}

export function getPostMortem(
  postMortemPrompt: string,
  agentId:          string,
): Promise<ClaudeCallResult<PostMortemResult>> {
  return callOllama(POST_MORTEM_SYSTEM, postMortemPrompt, 'postmortem', agentId, MODELS.postmortem);
}

export function getSynthesis(
  synthesisPrompt: string,
  agentId:         string,
): Promise<ClaudeCallResult<{ rules: any[] }>> {
  return callOllama(SYNTHESIS_SYSTEM, synthesisPrompt, 'synthesis', agentId, MODELS.synthesis);
}

// ─────────────────────────────────────────────
// Core caller
// ─────────────────────────────────────────────

async function callOllama<T>(
  systemPrompt: string,
  userPrompt:   string,
  promptType:   string,
  agentId:      string,
  model:        string,
): Promise<ClaudeCallResult<T>> {

  const startedAt = Date.now();
  let   lastError = '';

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user',   content: userPrompt   },
          ],
          stream: false,
          options: {
            temperature: 0.2,
            num_predict: 2000,
          },
          format: 'json',  // forces Ollama to return valid JSON
        }),
      });

      if (!res.ok) {
        throw new Error(`Ollama HTTP ${res.status}: ${await res.text()}`);
      }

      const data    = await res.json() as any;
      const rawText = data.message?.content ?? '';

      if (!rawText) {
        throw new Error('Empty response from Ollama');
      }

      // DeepSeek-R1 wraps output in <think>...</think> blocks
      // Strip thinking tokens — only keep the JSON
      const cleaned = stripThinkingTokens(rawText);

      const parsed = parseJSON<T>(cleaned);

      if (!parsed.success) {
        throw new Error(`JSON parse failed: ${parsed.error} | Raw: ${cleaned.slice(0, 200)}`);
      }

      const durationMs = Date.now() - startedAt;

      logger.info('Ollama call completed', {
        agentId,
        promptType,
        model,
        durationMs,
        evalTokens: data.eval_count ?? 0,
      });

      return {
        success:     true,
        data:        parsed.data,
        rawResponse: rawText,
        tokensUsed: {
          inputTokens:  data.prompt_eval_count ?? 0,
          outputTokens: data.eval_count        ?? 0,
          cacheHits:    0,
          totalCost:    0,  // local — free
        },
        error:     null,
        durationMs,
      };

    } catch (error: any) {
      lastError = error?.message ?? 'Unknown error';

      logger.warn(`Ollama attempt ${attempt} failed`, {
        agentId,
        promptType,
        model,
        error: lastError,
      });

      if (attempt < MAX_RETRIES) await sleep(1000 * attempt);
    }
  }

  logger.error('Ollama call failed after all retries', {
    agentId,
    promptType,
    model,
    lastError,
  });

  return {
    success:     false,
    data:        null,
    rawResponse: '',
    tokensUsed:  { inputTokens: 0, outputTokens: 0, cacheHits: 0, totalCost: 0 },
    error:       lastError,
    durationMs:  Date.now() - startedAt,
  };
}

// ─────────────────────────────────────────────
// Strip DeepSeek-R1 thinking tokens
// R1 models output <think>...</think> before JSON
// We only want what comes after
// ─────────────────────────────────────────────

function stripThinkingTokens(raw: string): string {
  // Remove <think>...</think> block entirely
  const withoutThink = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

  // If something remains after stripping — use it
  if (withoutThink.length > 0) return withoutThink;

  // Fallback — return original if no think block found
  return raw.trim();
}

// ─────────────────────────────────────────────
// JSON parser with repair
// ─────────────────────────────────────────────

export function parseJSON<T>(raw: string): {
  success: boolean;
  data:    T | null;
  error:   string | null;
} {
  const cleaned = raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  // 1. Direct parse
  try {
    return { success: true, data: JSON.parse(cleaned), error: null };
  } catch {}

  // 2. Extract JSON block
  try {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      const candidate = cleanJSON(match[0]);
      return { success: true, data: JSON.parse(candidate), error: null };
    }
  } catch {}

  // 3. Repair truncated JSON
  try {
    const repaired = repairJSON(cleaned);
    return { success: true, data: JSON.parse(repaired), error: null };
  } catch {}

  return {
    success: false,
    data:    null,
    error:   `No valid JSON found. Raw: ${raw.slice(0, 200)}`,
  };
}

function cleanJSON(str: string): string {
  return str
    .replace(/,\s*}/g, '}')
    .replace(/,\s*]/g, ']')
    .trim();
}

function repairJSON(raw: string): string {
  let str    = raw.trim();
  const opens  = (str.match(/\{/g) ?? []).length;
  const closes = (str.match(/\}/g) ?? []).length;
  const diff   = opens - closes;

  if (diff > 0) {
    // Close any open string
    const lastBrace = str.lastIndexOf('}');
    const tail      = str.slice(lastBrace + 1);
    const quotes    = (tail.match(/(?<!\\)"/g) ?? []).length;
    if (quotes % 2 !== 0) str += '"';

    // Close arrays
    const openArrays  = (str.match(/\[/g) ?? []).length;
    const closeArrays = (str.match(/\]/g) ?? []).length;
    str += ']'.repeat(openArrays - closeArrays);

    // Close objects
    str += '}'.repeat(diff);
  }

  return str;
}

// ─────────────────────────────────────────────
// System prompts for non-trading calls
// ─────────────────────────────────────────────

const POST_MORTEM_SYSTEM = `
You are a trading performance analyst.
Analyze losing trades objectively and identify clear patterns.
Return ONLY valid JSON. No explanations outside JSON.
`.trim();

const SYNTHESIS_SYSTEM = `
You are an expert at synthesizing trading lessons.
Compress multiple lessons into actionable rules.
Return ONLY valid JSON. No explanations outside JSON.
`.trim();

// ─────────────────────────────────────────────
// Util
// ─────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}