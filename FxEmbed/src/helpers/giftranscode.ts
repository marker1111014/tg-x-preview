import { Context } from 'hono';
import { Constants } from '../constants';
import { experimentCheck, Experiment } from '../experiments';
import { getGIFTranscodeDomain as getGIFTranscodeDomainCore } from '@fxembed/atmosphere/helpers';

export const getGIFTranscodeDomain = (twitterId: string): string | null =>
  getGIFTranscodeDomainCore(twitterId, Constants.GIF_TRANSCODE_DOMAIN_LIST);

function isApiOrWebhookPath(c: Context, pathname: string): boolean {
  const routedPath = c.req.path || pathname;
  return (
    routedPath === '/tg-webhook' ||
    routedPath.startsWith('/tg-webhook/') ||
    routedPath === '/api' ||
    routedPath.startsWith('/api/') ||
    routedPath.startsWith('/blueskyapi/') ||
    routedPath.startsWith('/atmosphere/') ||
    pathname.startsWith('/2/')
  );
}

export const shouldTranscodeGif = (c: Context) => {
  const url = new URL(c.req.url);
  return (
    experimentCheck(Experiment.TRANSCODE_GIFS, Constants.GIF_TRANSCODE_DOMAIN_LIST.some(Boolean)) &&
    !c.req.header('user-agent')?.includes('TelegramBot') &&
    !Constants.OLD_EMBED_DOMAINS.includes(url.hostname) &&
    !Constants.API_HOST_LIST.includes(url.hostname) &&
    !Constants.BLUESKY_API_HOST_LIST.includes(url.hostname) &&
    !Constants.ATMOSPHERE_API_HOST_LIST.includes(url.hostname) &&
    !isApiOrWebhookPath(c, url.pathname)
  );
};
