/**
 * @tip/llm — the ONLY package that talks to DeepSeek. Zod-validated JSON, retries on network
 * and 5xx (never on schema failure), and `callWithLog` writes one `llm_call_log` row per call.
 * If any other package imports the DeepSeek SDK directly, §23's cost-vs-value question breaks.
 */
export * from './client.js';
export * from './cost.js';
export * from './log.js';
