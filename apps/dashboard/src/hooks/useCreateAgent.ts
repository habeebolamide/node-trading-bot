import { useMutation, useQueryClient } from '@tanstack/react-query';

export interface CreateAgentBody {
  name: string;
  domain: 'perp' | 'memecoin';
  tradingStyle: 'scalp' | 'day' | 'swing';
  universe: string[];
  /** Full ScoringConfig JSON — the api's `validateScoringConfig` will reject invalid shapes. */
  config: Record<string, unknown>;
}

/** POST /trading-agents. Invalidates the agents cache on success so the list refreshes.
 *  Errors surface as ApiError-shaped rejections; the form component maps them to inline text. */
export function useCreateAgent() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreateAgentBody) => {
      const res = await fetch('/trading-agents', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
      return json;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ['agents'] }),
  });
}
