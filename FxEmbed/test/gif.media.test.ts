import { describe, expect, it, afterEach, vi } from 'vitest';
import type { Context } from 'hono';
import { app } from '../src/worker';
import { Constants } from '../src/constants';
import { shouldTranscodeGif } from '../src/helpers/giftranscode';
import harness from './helpers/harness';
import tweet20 from './mocks/TweetResultsByRestIds/20.json';

function createGifProxy(): Fetcher {
  const baseResult = structuredClone(tweet20.data.tweetResult[0].result) as Record<string, unknown>;
  const baseLegacy = tweet20.data.tweetResult[0].result.legacy;
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
  const merged = {
    ...baseResult,
    rest_id: '2122613948147236910',
    legacy: {
      ...baseLegacy,
      id_str: '2122613948147236910',
      full_text: 'gif test https://t.co/2iTlN5AuWv',
      display_text_range: [0, 8],
      entities: { ...baseLegacy.entities, media: [gifMedia] },
      extended_entities: { media: [gifMedia] }
    }
  };
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

function makeFakeContext(url: string, path: string, userAgent = 'MyFxBot/1.0'): Context {
  return {
    req: {
      url,
      path,
      header: (name: string) => (name.toLowerCase() === 'user-agent' ? userAgent : undefined)
    }
  } as unknown as Context;
}

describe('GIF transcoding gating & media endpoints', () => {
  const originalTranscodeList = [...Constants.GIF_TRANSCODE_DOMAIN_LIST];
  const originalStandardList = [...Constants.STANDARD_DOMAIN_LIST];

  afterEach(() => {
    Constants.GIF_TRANSCODE_DOMAIN_LIST.splice(
      0,
      Constants.GIF_TRANSCODE_DOMAIN_LIST.length,
      ...originalTranscodeList
    );
    Constants.STANDARD_DOMAIN_LIST.splice(
      0,
      Constants.STANDARD_DOMAIN_LIST.length,
      ...originalStandardList
    );
    vi.restoreAllMocks();
  });

  it('disables GIF transcoding for API/webhook paths and empty domain lists, while preserving Twitter @api paths', () => {
    Constants.GIF_TRANSCODE_DOMAIN_LIST.splice(
      0,
      Constants.GIF_TRANSCODE_DOMAIN_LIST.length,
      'gif.fxtwitter.com'
    );

    expect(
      shouldTranscodeGif(
        makeFakeContext('https://my-fxembed.example.workers.dev/tg-webhook', '/tg-webhook')
      )
    ).toBe(false);
    expect(
      shouldTranscodeGif(
        makeFakeContext(
          'https://my-fxembed.example.workers.dev/2/status/2122613948147236910',
          '/api/2/status/2122613948147236910'
        )
      )
    ).toBe(false);
    expect(
      shouldTranscodeGif(
        makeFakeContext('https://api.fxtwitter.com/2/status/20', '/api/2/status/20')
      )
    ).toBe(false);
    expect(
      shouldTranscodeGif(
        makeFakeContext('https://api.fxbsky.app/2/status/abc', '/blueskyapi/2/status/abc')
      )
    ).toBe(false);
    expect(
      shouldTranscodeGif(
        makeFakeContext('https://api.atmosphere.tools/2/status/abc', '/atmosphere/2/status/abc')
      )
    ).toBe(false);
    expect(
      shouldTranscodeGif(
        makeFakeContext(
          'https://fxtwitter.com/jack/status/20',
          '/twitter/jack/status/20',
          'TelegramBot'
        )
      )
    ).toBe(false);

    // Twitter handle @api must NOT be mistaken for an API path
    expect(
      shouldTranscodeGif(
        makeFakeContext(
          'https://fxtwitter.com/api/status/20',
          '/twitter/api/status/20',
          'Discordbot/2.0'
        )
      )
    ).toBe(true);

    // Empty domain list disables GIF transcoding
    Constants.GIF_TRANSCODE_DOMAIN_LIST.splice(0, Constants.GIF_TRANSCODE_DOMAIN_LIST.length);
    expect(
      shouldTranscodeGif(
        makeFakeContext(
          'https://fxtwitter.com/jack/status/20',
          '/twitter/jack/status/20',
          'Discordbot/2.0'
        )
      )
    ).toBe(false);
  });

  it('returns MP4 URL and formats for same-domain /2/status/:id on GIF tweets', async () => {
    const env = { ...harness, TwitterProxy: createGifProxy() };
    const res = await app.request(
      new Request('https://my-fxembed.example.workers.dev/2/status/2122613948147236910', {
        method: 'GET',
        headers: { 'User-Agent': 'MyFxBot/1.0' }
      }),
      undefined,
      env
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      code: number;
      status: { media?: { all?: Array<Record<string, unknown>> } };
    };
    expect(json.code).toBe(200);
    const media = json.status.media?.all?.[0];
    expect(media?.type).toBe('gif');
    expect(media?.url).toBe('https://video.twimg.com/tweet_video/HXUFz9Ra8AAoXnv.mp4');
    expect(Array.isArray(media?.formats)).toBe(true);
  });

  it('handles /photo/1 overrideMedia on GIF tweets for both Discord (transcoded) and Telegram (MP4)', async () => {
    const env = { ...harness, TwitterProxy: createGifProxy() };

    const tgRes = await app.request(
      new Request('https://fxtwitter.com/jgy1472631/status/2122613948147236910/photo/1', {
        method: 'GET',
        headers: { 'User-Agent': 'TelegramBot (like TwitterBot)' }
      }),
      undefined,
      env
    );
    expect(tgRes.status).toBe(200);
    const tgHtml = await tgRes.text();
    expect(tgHtml).toContain('twitter:card" content="player"');
    expect(tgHtml).toContain(
      encodeURIComponent('https://video.twimg.com/tweet_video/HXUFz9Ra8AAoXnv.mp4')
    );

    const botRes = await app.request(
      new Request('https://fxtwitter.com/jgy1472631/status/2122613948147236910/photo/1', {
        method: 'GET',
        headers: {
          'User-Agent': 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)'
        }
      }),
      undefined,
      env
    );
    expect(botRes.status).toBe(200);
    const botHtml = await botRes.text();
    expect(botHtml).toContain('https://gif.fxtwitter.com/tweet_video/HXUFz9Ra8AAoXnv.');
    expect(botHtml).not.toContain(
      '<meta property="og:image" content="https://pbs.twimg.com/tweet_video_thumb/'
    );
  });

  it('redirects .jpg?name=large direct media on GIF tweets to MP4 for TelegramBot without appending name=large', async () => {
    Constants.STANDARD_DOMAIN_LIST.push('workers.dev');
    const env = { ...harness, TwitterProxy: createGifProxy() };
    const res = await app.request(
      new Request(
        'https://my-fxembed.example.workers.dev/jgy1472631/status/2122613948147236910.jpg?name=large',
        {
          method: 'GET',
          headers: { 'User-Agent': 'TelegramBot (like TwitterBot)' }
        }
      ),
      undefined,
      env
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      'https://video.twimg.com/tweet_video/HXUFz9Ra8AAoXnv.mp4'
    );
  });
});
