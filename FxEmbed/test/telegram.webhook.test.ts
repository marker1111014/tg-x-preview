import { describe, expect, it, vi, afterEach } from 'vitest';
import { app } from '../src/worker';
import { buildTelegramCaption, extractStatusRefs } from '../src/realms/telegram/webhook';
import type { APITwitterStatus } from '../src/realms/api/schemas';
import harness from './helpers/harness';

const BASE_ENV = {
  ...harness,
  TG_BOT_TOKEN: '123456:TEST_TOKEN',
  TG_WEBHOOK_SECRET: 'test_secret_123',
  TG_ALLOWED_USERS: '1001,1002'
};

describe('Telegram webhook helpers', () => {
  it('extracts and deduplicates X/Twitter status links', () => {
    const refs = extractStatusRefs(
      '看這篇 https://x.com/ratatatat74/status/2108926814131527831?s=20 與 https://twitter.com/i/web/status/2108926814131527831',
      {
        message_id: 1,
        chat: { id: 1001 },
        entities: [{ type: 'text_link', url: 'https://x.com/jack/status/20?t=abc' }]
      }
    );

    expect(refs).toEqual([
      { rawPath: 'ratatatat74/status/2108926814131527831', statusId: '2108926814131527831' },
      { rawPath: 'jack/status/20', statusId: '20' }
    ]);
  });

  it('escapes HTML and truncates long captions cleanly within limit', () => {
    const longText = 'A & <tag> '.repeat(150);
    const status = {
      id: '20',
      url: 'https://x.com/jack/status/20',
      text: longText,
      author: { name: 'Jack <Test>', screen_name: 'jack' }
    } as unknown as APITwitterStatus;

    const { caption, overflowText } = buildTelegramCaption(status, 1024);
    expect(caption.length).toBeLessThanOrEqual(1024);
    expect(caption).toContain('<b>Jack &lt;Test&gt;</b>');
    expect(caption).toContain('…');
    expect(overflowText).not.toBeNull();
  });
});

describe('POST /tg-webhook routing and auth', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects requests without valid secret token', async () => {
    const res = await app.request(
      new Request('https://my-fxembed.example.workers.dev/tg-webhook', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ update_id: 1 })
      }),
      undefined,
      BASE_ENV
    );
    expect(res.status).toBe(401);
  });

  it('returns 503 if TG secrets are not configured', async () => {
    const res = await app.request(
      new Request('https://my-fxembed.example.workers.dev/tg-webhook', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ update_id: 1 })
      }),
      undefined,
      harness
    );
    expect(res.status).toBe(503);
  });

  it('ignores updates from unauthorized user ids', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await app.request(
      new Request('https://my-fxembed.example.workers.dev/tg-webhook', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Telegram-Bot-Api-Secret-Token': BASE_ENV.TG_WEBHOOK_SECRET
        },
        body: JSON.stringify({
          update_id: 1,
          message: {
            message_id: 10,
            chat: { id: 9999 },
            from: { id: 9999 },
            text: '/start'
          }
        })
      }),
      undefined,
      BASE_ENV
    );
    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('responds to /d command for authorized users', async () => {
    const calls: Array<{ url: string; body: string }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      calls.push({ url, body: String(init?.body ?? '') });
      return new Response(JSON.stringify({ ok: true, result: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    });

    const res = await app.request(
      new Request('https://my-fxembed.example.workers.dev/tg-webhook', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Telegram-Bot-Api-Secret-Token': BASE_ENV.TG_WEBHOOK_SECRET
        },
        body: JSON.stringify({
          update_id: 2,
          message: {
            message_id: 11,
            chat: { id: 1001 },
            from: { id: 1001 },
            text: '/d https://x.com/ratatatat74/status/2108926814131527831?s=20'
          }
        })
      }),
      undefined,
      BASE_ENV
    );

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.telegram.org/bot123456:TEST_TOKEN/sendMessage');
    expect(calls[0]!.body).toContain(
      'https://my-fxembed.example.workers.dev/ratatatat74/status/2108926814131527831.jpg?name=large'
    );
  });

  it('sends multi-photo tweets as native media group via sendMediaGroup', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      calls.push({ url, body });
      return new Response(JSON.stringify({ ok: true, result: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    });

    const res = await app.request(
      new Request('https://my-fxembed.example.workers.dev/tg-webhook', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Telegram-Bot-Api-Secret-Token': BASE_ENV.TG_WEBHOOK_SECRET
        },
        body: JSON.stringify({
          update_id: 3,
          message: {
            message_id: 12,
            chat: { id: 1001 },
            from: { id: 1001 },
            text: 'https://x.com/SpaceX/status/1848831595014459513?s=20'
          }
        })
      }),
      undefined,
      BASE_ENV
    );

    expect(res.status).toBe(200);
    const mediaGroupCall = calls.find(c => c.url.endsWith('/sendMediaGroup'));
    expect(mediaGroupCall).toBeDefined();
    const mediaArr = mediaGroupCall!.body.media as Array<{ type: string; media: string }>;
    expect(mediaArr.length).toBeGreaterThanOrEqual(2);
    expect(mediaArr[0]!.type).toBe('photo');
    expect(mediaArr[0]!.media).toContain('name=large');
  });
});
