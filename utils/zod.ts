import { z } from "zod";

export const EntrySignalSchema = z.object({
  action: z.enum(["LONG", "SHORT", "NO_TRADE"]),
  entry: z.number().nullable(),
  tp: z.number().nullable(),
  sl: z.number().nullable(),
  confidence: z.number(),
  timeframe_used: z.string(),
  reasoning: z.string().nullable(),
  what_invalidates: z.string(),
  tradeStyle: z.string(),
  entry_expiry_minutes: z.number().nullable().optional(),
  triggers: z
    .object({
      price_up: z.number().nullable().optional(),
      price_down: z.number().nullable().optional(),
      timeout_minutes: z.number().nullable().optional(),
    })
    .optional(),
});