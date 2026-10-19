import { afterEach, it, expect, vi } from 'vitest';
import {
  telegramSender,
  preferencesInput,
} from '../../packages/notifications/src/service.js';
afterEach(() => vi.unstubAllGlobals());
it('uses the Telegram Bot API envelope, acknowledges only a returned message ID and preserves flood-control timing', async () => {
  const fakeFetch = vi.fn();
  vi.stubGlobal('fetch', fakeFetch);
  const send = telegramSender('123:synthetic_fixture'),
    signal = new AbortController().signal;
  fakeFetch.mockResolvedValueOnce(
    new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), {
      status: 200,
    }),
  );
  expect(await send('-123', 'PAPER / SIMULATED', signal)).toEqual({
    messageId: '42',
  });
  const request = fakeFetch.mock.calls[0]!;
  expect(request[0]).toBe(
    'https://api.telegram.org/bot123:synthetic_fixture/sendMessage',
  );
  expect(JSON.parse(request[1].body)).toEqual({
    chat_id: '-123',
    text: 'PAPER / SIMULATED',
  });
  fakeFetch.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        ok: false,
        error_code: 429,
        parameters: { retry_after: 90 },
      }),
      { status: 429 },
    ),
  );
  expect(await send('123', 'Fixture', signal)).toEqual({
    error: 'RATE_LIMIT',
    retryAfter: 90,
  });
  fakeFetch.mockResolvedValueOnce(
    new Response(JSON.stringify({ ok: true }), { status: 200 }),
  );
  expect(await send('123', 'Fixture', signal)).toEqual({
    error: 'UNAVAILABLE',
  });
  fakeFetch.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        ok: false,
        description: 'Do not persist arbitrary response content',
      }),
      { status: 401 },
    ),
  );
  expect(await send('123', 'Fixture', signal)).toEqual({ error: 'REJECTED' });
});
it('validates opt-in routing and disallows NO_TRADE and arbitrary destination strings', () => {
  expect(
    preferencesInput.safeParse({
      enabled: true,
      recipientRef: null,
      events: [],
    }).success,
  ).toBe(false);
  expect(
    preferencesInput.safeParse({
      enabled: true,
      recipientRef: 'https://example.com',
      events: [],
    }).success,
  ).toBe(false);
  expect(
    preferencesInput.safeParse({
      enabled: true,
      recipientRef: '123',
      events: ['NO_TRADE'],
    }).success,
  ).toBe(false);
  expect(
    preferencesInput.parse({ enabled: false, recipientRef: null, events: [] })
      .botId,
  ).toBe(null);
});
