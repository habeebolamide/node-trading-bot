import { GoogleGenerativeAI, GenerativeModel } from '@google/generative-ai';
import logger from '../utils/logger';
import { ClaudeCallOptions, ClaudeCallResult, ClaudeModel, EntrySignal, ManagementDecision, PostMortemResult, TokenUsage } from '../types/claude.types';


// ─────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────

const MODEL_PRO   = 'gemini-2.5-pro';
const MODEL_FLASH = 'gemini-2.5-flash';
const MAX_RETRIES    = 3;
const RETRY_DELAY_MS = 2000;

// ─────────────────────────────────────────────
// Gemini client singleton
// ─────────────────────────────────────────────

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? '');

// ─────────────────────────────────────────────
// Public — entry signal
// Uses Pro — needs strongest reasoning
// ─────────────────────────────────────────────

export async function getEntrySignal(
  systemPrompt: string,
  entryPrompt:  string,
  agentId:      string,
): Promise<ClaudeCallResult<EntrySignal>> {
  return callGemini<EntrySignal>({
    systemPrompt,
    userPrompt: entryPrompt,
    model:      MODEL_PRO,
    promptType: 'entry',
    agentId,
  });
}

// ─────────────────────────────────────────────
// Public — management decision
// Flash for HOLD check, Pro if adjustment needed
// ─────────────────────────────────────────────

export async function getManagementDecision(
  systemPrompt:     string,
  managementPrompt: string,
  agentId:          string,
): Promise<ClaudeCallResult<ManagementDecision>> {
  // First pass with Flash — cheap
  const flashResult = await callGemini<ManagementDecision>({
    systemPrompt,
    userPrompt: managementPrompt,
    model:      MODEL_FLASH,
    promptType: 'management',
    agentId,
  });

  // If Flash says HOLD — trust it, no need to escalate
  if (flashResult.success && flashResult.data?.action === 'HOLD') {
    return flashResult;
  }

  // Flash wants to adjust or close — escalate to Pro
  logger.info('Escalating management decision to Pro', { agentId });

  return callGemini<ManagementDecision>({
    systemPrompt,
    userPrompt: managementPrompt,
    model:      MODEL_PRO,
    promptType: 'management',
    agentId,
  });
}

// ─────────────────────────────────────────────
// Public — post-mortem analysis
// ─────────────────────────────────────────────

export async function getPostMortem(
  postMortemPrompt: string,
  agentId:          string,
): Promise<ClaudeCallResult<PostMortemResult>> {
  return callGemini<PostMortemResult>({
    systemPrompt: POST_MORTEM_SYSTEM,
    userPrompt:   postMortemPrompt,
    model:        MODEL_FLASH,
    promptType:   'postmortem',
    agentId,
  });
}

// ─────────────────────────────────────────────
// Public — lesson synthesis (weekly job)
// ─────────────────────────────────────────────

export async function getSynthesis(
  synthesisPrompt: string,
  agentId:         string,
): Promise<ClaudeCallResult<{ rules: any[] }>> {
  return callGemini<{ rules: any[] }>({
    systemPrompt: POST_MORTEM_SYSTEM,
    userPrompt:   synthesisPrompt,
    model:        MODEL_PRO,
    promptType:   'synthesis',
    agentId,
  });
}

// ─────────────────────────────────────────────
// Core caller — all public functions go through here
// ─────────────────────────────────────────────

async function callGemini<T>({
  systemPrompt,
  userPrompt,
  model,
  promptType,
  agentId,
}: {
  systemPrompt: string;
  userPrompt:   string;
  model:        string;
  promptType:   string;
  agentId:      string;
}): Promise<ClaudeCallResult<T>> {
  const startedAt = Date.now();
  let   lastError: string | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const geminiModel: GenerativeModel = genAI.getGenerativeModel({
        model,
        systemInstruction: systemPrompt,
        generationConfig: {
          responseMimeType: 'application/json', // forces clean JSON output
          temperature:      0.2,                // low = consistent, less hallucination
        },
      });

      const result  = await geminiModel.generateContent(userPrompt);
      const rawText = result.response.text();
      const usage   = result.response.usageMetadata;

      const tokenUsage: TokenUsage = {
        inputTokens:  usage?.promptTokenCount     ?? 0,
        outputTokens: usage?.candidatesTokenCount ?? 0,
        cacheHits:    0,
        totalCost:    0, // free tier — no cost tracking needed yet
      };

      logger.info('Gemini call completed', {
        agentId,
        promptType,
        model,
        tokens:     tokenUsage,
        durationMs: Date.now() - startedAt,
      });

      const parsed = parseJSON<T>(rawText);

      if (!parsed.success) {
        logger.warn('Gemini returned invalid JSON', {
          agentId,
          promptType,
          raw: rawText.slice(0, 200),
        });

        lastError = `JSON parse failed: ${parsed.error}`;

        if (attempt < MAX_RETRIES) {
          await sleep(RETRY_DELAY_MS * attempt);
          continue;
        }
      }

      return {
        success:     parsed.success,
        data:        parsed.data,
        rawResponse: rawText,
        tokensUsed:  tokenUsage,
        error:       parsed.error,
        durationMs:  Date.now() - startedAt,
      };

    } catch (error: any) {
      lastError = error?.message ?? 'Unknown error';

      logger.warn(`Gemini attempt ${attempt} failed`, {
        agentId,
        promptType,
        error: lastError,
      });

      // Rate limit hit — wait longer
      if (error?.status === 429) {
        logger.warn('Rate limit hit — waiting 10s', { agentId });
        await sleep(10_000);
        continue;
      }

      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS * attempt);
      }
    }
  }

  logger.error('Gemini call failed after all retries', {
    agentId,
    promptType,
    error: lastError,
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
// JSON parser — handles both clean JSON and
// markdown-wrapped responses
// ─────────────────────────────────────────────

function parseJSON<T>(raw: string): {
  success: boolean;
  data:    T | null;
  error:   string | null;
} {
  try {
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
// Minimal system prompt for post-mortem calls
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