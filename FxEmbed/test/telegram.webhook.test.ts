import { describe, expect, it, vi, afterEach } from 'vitest';
import { app } from '../src/worker';
import {
  buildTelegramCaption,
  detectBinaryMediaKind,
  extractStatusRefs,
  isStaticImageUrl,
  pickVideoCandidates
} from '../src/realms/telegram/webhook';
import type { APITwitterStatus } from '../src/realms/api/schemas';
import harness from './helpers/harness';
import tweet20 from './mocks/TweetResultsByRestIds/20.json';

const BASE_ENV = {
  ...harness,
  TG_BOT_TOKEN: '123456:TEST_TOKEN',
  TG_WEBHOOK_SECRET: 'test_secret_123',
  TG_ALLOWED_USERS: '1001,1002'
};

function createCustomTweetProxy(tweetOverride: Record<string, unknown>): Fetcher {
  const baseResult = structuredClone(tweet20.data.tweetResult[0].result) as Record<string, unknown>;
  const merged = { ...baseResult, ...tweetOverride };
  return {
    fetch: async (request: RequestInfo | URL) => {
      const urlStr =
        typeof request === 'string'
          ? request
          : request instanceof URL
            ? request.toString()
            : request.url;
      if (urlStr.includes('TweetResultByRestId')) {
        return new Response(JSON.stringify({ data: { tweetResult: { result: merged } } }));
      }
      return new Response(JSON.stringify({ data: { tweetResult: [{ result: merged }] } }));
    }
  } as unknown as Fetcher;
}

function makeGifTweetOverride(includeSecondPhoto = false): Record<string, unknown> {
  const gifMedia = {
    display_url: 'pic.x.com/HXUFz9Ra8A',
    expanded_url: 'https://x.com/jgy1472631/status/2122613948147236910/photo/1',
    id_str: '2122609189554155520',
    indices: [10, 33],
    media_url_https: 'https://pbs.twimg.com/tweet_video_thumb/HXUFz9Ra8AAoXnv.jpg',
    original_info: { height: 320, width: 320 },
    sizes: { large: { h: 320, resize: 'fit', w: 320 } },
    type: 'animated_gif',
    url: 'https://t.co/2iTlN5AuWv',
    video_info: {
      aspect_ratio: [1, 1],
      variants: [
        {
          bitrate: 0,
          content_type: 'video/mp4',
          url: 'https://video.twimg.com/tweet_video/HXUFz9Ra8AAoXnv.mp4'
        }
      ]
    }
  };
  const mediaList: Record<string, unknown>[] = [gifMedia];
  if (includeSecondPhoto) {
    mediaList.push({
      display_url: 'pic.x.com/SECOND',
      expanded_url: 'https://x.com/jgy1472631/status/2122613948147236910/photo/2',
      id_str: '2122609189554155521',
      indices: [10, 33],
      media_url_https: 'https://pbs.twimg.com/media/TEST_SECOND.jpg',
      original_info: { height: 800, width: 600 },
      sizes: { large: { h: 800, resize: 'fit', w: 600 } },
      type: 'photo',
      url: 'https://t.co/2iTlN5AuWv'
    });
  }
  const baseLegacy = tweet20.data.tweetResult[0].result.legacy;
  return {
    rest_id: '2122613948147236910',
    legacy: {
      ...baseLegacy,
      id_str: '2122613948147236910',
      full_text: 'gif test https://t.co/2iTlN5AuWv',
      display_text_range: [0, 8],
      entities: { ...baseLegacy.entities, media: mediaList },
      extended_entities: { media: mediaList }
    }
  };
}

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

  it('identifies static image URLs and filters them from video candidates', () => {
    expect(isStaticImageUrl('https://pbs.twimg.com/tweet_video_thumb/HXUFz9Ra8AAoXnv.jpg')).toBe(
      true
    );
    expect(isStaticImageUrl('https://pbs.twimg.com/media/abc.png?name=orig')).toBe(true);
    expect(isStaticImageUrl('https://video.twimg.com/tweet_video/HXUFz9Ra8AAoXnv.mp4')).toBe(false);
    expect(isStaticImageUrl('https://gif.fxtwitter.com/tweet_video/HXUFz9Ra8AAoXnv.gif')).toBe(
      false
    );

    const cands = pickVideoCandidates({
      type: 'gif',
      url: 'https://pbs.twimg.com/tweet_video_thumb/HXUFz9Ra8AAoXnv.jpg',
      width: 320,
      height: 320,
      transcode_url: 'https://gif.fxtwitter.com/tweet_video/HXUFz9Ra8AAoXnv.gif'
    });
    expect(cands).toEqual(['https://gif.fxtwitter.com/tweet_video/HXUFz9Ra8AAoXnv.gif']);
  });

  it('detects binary media kind via magic bytes', () => {
    const mp4 = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32])
      .buffer;
    const gif = new TextEncoder().encode('GIF89a......').buffer;
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]).buffer;

    expect(detectBinaryMediaKind(mp4, 'application/octet-stream')).toBe('mp4');
    expect(detectBinaryMediaKind(gif, 'application/octet-stream')).toBe('gif');
    expect(detectBinaryMediaKind(jpeg, 'video/mp4')).toBe('jpeg');
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

  it('sends single GIF tweet via sendAnimation with MP4 URL (not static jpg thumbnail)', async () => {
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

    const env = { ...BASE_ENV, TwitterProxy: createCustomTweetProxy(makeGifTweetOverride(false)) };
    const res = await app.request(
      new Request('https://my-fxembed.example.workers.dev/tg-webhook', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Telegram-Bot-Api-Secret-Token': BASE_ENV.TG_WEBHOOK_SECRET
        },
        body: JSON.stringify({
          update_id: 4,
          message: {
            message_id: 13,
            chat: { id: 1001 },
            from: { id: 1001 },
            text: 'https://x.com/jgy1472631/status/2122613948147236910'
          }
        })
      }),
      undefined,
      env
    );

    expect(res.status).toBe(200);
    const animCall = calls.find(c => c.url.endsWith('/sendAnimation'));
    expect(animCall).toBeDefined();
    expect(animCall!.body.animation).toBe(
      'https://video.twimg.com/tweet_video/HXUFz9Ra8AAoXnv.mp4'
    );
    expect(String(animCall!.body.animation)).not.toContain('tweet_video_thumb');
  });

  it('falls back to MP4 binary upload when sendAnimation URL fails, and rejects static JPEG bytes', async () => {
    const mp4Bytes = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]);
    let uploadedFilename = '';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.endsWith('/sendAnimation')) {
        if (init?.body instanceof FormData) {
          const file = init.body.get('animation');
          uploadedFilename = file instanceof File ? file.name : 'blob';
          return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: false, description: 'failed to get HTTP URL' }), {
          status: 400
        });
      }
      if (url.endsWith('.mp4')) {
        return new Response(mp4Bytes, {
          status: 200,
          headers: { 'content-type': 'video/mp4' }
        });
      }
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    });

    const env = { ...BASE_ENV, TwitterProxy: createCustomTweetProxy(makeGifTweetOverride(false)) };
    const res = await app.request(
      new Request('https://my-fxembed.example.workers.dev/tg-webhook', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Telegram-Bot-Api-Secret-Token': BASE_ENV.TG_WEBHOOK_SECRET
        },
        body: JSON.stringify({
          update_id: 5,
          message: {
            message_id: 14,
            chat: { id: 1001 },
            from: { id: 1001 },
            text: 'https://x.com/jgy1472631/status/2122613948147236910'
          }
        })
      }),
      undefined,
      env
    );
    expect(res.status).toBe(200);
    expect(uploadedFilename).toBe('video.mp4');

    // Now test static JPEG interception: server returns JPEG bytes for .mp4 URL -> falls back to sendMessage link
    vi.restoreAllMocks();
    const sentMessages: string[] = [];
    const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.endsWith('/sendAnimation')) {
        if (init?.body instanceof FormData) {
          throw new Error('Should not upload static JPEG bytes to sendAnimation');
        }
        return new Response(JSON.stringify({ ok: false, description: 'failed to get HTTP URL' }), {
          status: 400
        });
      }
      if (url.endsWith('.mp4')) {
        return new Response(jpegBytes, {
          status: 200,
          headers: { 'content-type': 'image/jpeg' }
        });
      }
      if (url.endsWith('/sendMessage')) {
        sentMessages.push(String(init?.body ?? ''));
      }
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    });

    const res2 = await app.request(
      new Request('https://my-fxembed.example.workers.dev/tg-webhook', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Telegram-Bot-Api-Secret-Token': BASE_ENV.TG_WEBHOOK_SECRET
        },
        body: JSON.stringify({
          update_id: 6,
          message: {
            message_id: 15,
            chat: { id: 1001 },
            from: { id: 1001 },
            text: 'https://x.com/jgy1472631/status/2122613948147236910'
          }
        })
      }),
      undefined,
      env
    );
    expect(res2.status).toBe(200);
    expect(sentMessages.some(m => m.includes('2122613948147236910'))).toBe(true);
  });

  it('sends GIF inside mixed media album as video MP4 in sendMediaGroup', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      calls.push({ url, body });
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    });

    const env = { ...BASE_ENV, TwitterProxy: createCustomTweetProxy(makeGifTweetOverride(true)) };
    const res = await app.request(
      new Request('https://my-fxembed.example.workers.dev/tg-webhook', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Telegram-Bot-Api-Secret-Token': BASE_ENV.TG_WEBHOOK_SECRET
        },
        body: JSON.stringify({
          update_id: 7,
          message: {
            message_id: 16,
            chat: { id: 1001 },
            from: { id: 1001 },
            text: 'https://x.com/jgy1472631/status/2122613948147236910'
          }
        })
      }),
      undefined,
      env
    );
    expect(res.status).toBe(200);
    const groupCall = calls.find(c => c.url.endsWith('/sendMediaGroup'));
    expect(groupCall).toBeDefined();
    const mediaArr = groupCall!.body.media as Array<{ type: string; media: string }>;
    expect(mediaArr).toHaveLength(2);
    expect(mediaArr[0]).toMatchObject({
      type: 'video',
      media: 'https://video.twimg.com/tweet_video/HXUFz9Ra8AAoXnv.mp4'
    });
    expect(mediaArr[1]).toMatchObject({
      type: 'photo',
      media: 'https://pbs.twimg.com/media/TEST_SECOND.jpg?name=large'
    });
  });
});
