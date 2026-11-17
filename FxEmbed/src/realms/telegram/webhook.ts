import { constructTwitterThread } from '@fxembed/atmosphere/providers/twitter/conversation';
import type { Context } from 'hono';
import { formatTelegramTwitterPostPhotoUrl } from '../../helpers/pbsProxy';
import { isTombstone } from '../../helpers/tombstone';
import { twitterBuildHostFromContext } from '../../providers/twitter/build-host-adapter';
import type { APIPhoto, APITwitterStatus, APIVideo } from '../api/schemas';

export type WorkerBindings = {
  /** Optional: tests use a Fetcher mock; production uses in-process proxy + CREDENTIAL_KEY. */
  TwitterProxy?: Fetcher;
  CREDENTIAL_KEY?: string;
  EXCEPTION_DISCORD_WEBHOOK?: string;
  AnalyticsEngine: AnalyticsEngineDataset;
  TG_BOT_TOKEN?: string;
  TG_WEBHOOK_SECRET?: string;
  TG_ALLOWED_USERS?: string;
};

type TelegramEntity = {
  type?: string;
  url?: string;
};

type TelegramUser = {
  id: number;
};

type TelegramMessage = {
  message_id: number;
  chat: { id: number };
  from?: TelegramUser;
  text?: string;
  caption?: string;
  entities?: TelegramEntity[];
  caption_entities?: TelegramEntity[];
  reply_to_message?: TelegramMessage;
};

type TelegramUpdate = {
  update_id?: number;
  message?: TelegramMessage;
};

type StatusRef = {
  rawPath: string;
  statusId: string;
};

type MediaItem = APIPhoto | APIVideo;

type TelegramApiResponse = {
  ok: boolean;
  description?: string;
  error_code?: number;
};

const MAX_CAPTION_LEN = 1024;
const MAX_TEXT_LEN = 4096;
const MAX_TG_VIDEO_URL_BYTES = 19_000_000;
const MAX_WORKER_UPLOAD_BYTES = 9_500_000;
const MAX_WORKER_GROUP_TOTAL_BYTES = 32_000_000;

const X_STATUS_RE =
  /https?:\/\/(?:www\.|mobile\.)?(?:x\.com|twitter\.com|fxtwitter\.com|fixupx\.com|twittpr\.com)\/((?:i\/web|[A-Za-z0-9_]+)\/status(?:es)?\/(\d+))(?:\S*)/gi;

function timingSafeEqualStrings(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < ab.length; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

function parseAllowedUsers(raw: string | undefined): Set<string> {
  const allowed = new Set<string>();
  if (!raw) return allowed;
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (/^\d+$/.test(trimmed)) {
      allowed.add(trimmed);
    }
  }
  return allowed;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function extractStatusRefs(text: string, message?: TelegramMessage): StatusRef[] {
  const sources: string[] = [];
  if (text) sources.push(text);
  if (message) {
    for (const ent of [...(message.entities ?? []), ...(message.caption_entities ?? [])]) {
      if (ent.url) sources.push(ent.url);
    }
  }

  const refs: StatusRef[] = [];
  const seen = new Set<string>();
  for (const src of sources) {
    for (const match of src.matchAll(X_STATUS_RE)) {
      let rawPath = match[1] ?? '';
      const statusId = match[2] ?? '';
      if (!rawPath || !statusId || seen.has(statusId)) continue;
      if (rawPath.toLowerCase().startsWith('i/web/')) {
        rawPath = rawPath.slice(6);
      }
      rawPath = rawPath.replace(/\/statuses\//i, '/status/');
      seen.add(statusId);
      refs.push({ rawPath, statusId });
    }
  }
  return refs;
}

export function buildTelegramCaption(
  status: APITwitterStatus,
  limit: number
): { caption: string; overflowText: string | null } {
  const name = escapeHtml(status.author?.name || 'Unknown');
  const screenName = escapeHtml(status.author?.screen_name || 'i');
  const postUrl = escapeHtml(
    status.url || `https://x.com/${status.author?.screen_name || 'i'}/status/${status.id}`
  );
  const header = `<b>${name}</b> (<a href="${postUrl}">@${screenName}</a>)`;

  const rawText = (status.text || '').trim();
  let quoteBlock = '';
  if (status.quote && !isTombstone(status.quote)) {
    const qHandle = status.quote.author?.screen_name || '';
    const qText = (status.quote.text || '').trim();
    if (qHandle || qText) {
      const snippet = qText.length <= 220 ? qText : `${qText.slice(0, 217)}…`;
      quoteBlock = `\n\n<blockquote>↪ @${escapeHtml(qHandle)}: ${escapeHtml(snippet)}</blockquote>`;
    }
  }

  if (!rawText && !quoteBlock) {
    return { caption: header, overflowText: null };
  }

  const fullBody = rawText ? `\n\n${escapeHtml(rawText)}` : '';
  const fullMsg = `${header}${fullBody}${quoteBlock}`;
  if (fullMsg.length <= limit) {
    return { caption: fullMsg, overflowText: null };
  }

  const reserved = header.length + quoteBlock.length + 8;
  const avail = Math.max(40, limit - reserved);
  let truncated = rawText.slice(0, avail);
  while (truncated && `${header}\n\n${escapeHtml(truncated)}…${quoteBlock}`.length > limit) {
    truncated = truncated.slice(0, truncated.length > 20 ? -10 : -1);
  }
  let shortMsg = `${header}\n\n${escapeHtml(truncated)}…${quoteBlock}`;
  if (shortMsg.length > limit) {
    shortMsg = header;
  }
  return { caption: shortMsg, overflowText: fullMsg.slice(0, MAX_TEXT_LEN) };
}

function collectMediaItems(status: APITwitterStatus): MediaItem[] {
  const primary = (status.media?.all ?? []).filter(
    (m): m is MediaItem => m.type === 'photo' || m.type === 'video' || m.type === 'gif'
  );
  if (primary.length > 0) return primary;
  if (status.quote && !isTombstone(status.quote)) {
    return (status.quote.media?.all ?? []).filter(
      (m): m is MediaItem => m.type === 'photo' || m.type === 'video' || m.type === 'gif'
    );
  }
  return [];
}

function getPhotoUrlForTelegram(url: string): string {
  return url.includes('pbs.twimg.com/media/') ? formatTelegramTwitterPostPhotoUrl(url, true) : url;
}

function estimateVideoBytes(
  format: { size?: number; bitrate?: number },
  durationSec: number
): number {
  if (typeof format.size === 'number' && format.size > 0) return format.size;
  if (typeof format.bitrate === 'number' && format.bitrate > 0 && durationSec > 0) {
    return (format.bitrate * durationSec) / 8;
  }
  return Number.POSITIVE_INFINITY;
}

function getMediaDuration(item: MediaItem): number {
  return 'duration' in item ? Number(item.duration || 0) : 0;
}

function pickVideoCandidates(item: MediaItem): string[] {
  const formats = 'formats' in item && Array.isArray(item.formats) ? item.formats : [];
  const mp4s = formats.filter(f => f.container === 'mp4' && Boolean(f.url));
  const duration = getMediaDuration(item);

  const fitting = mp4s
    .filter(f => estimateVideoBytes(f, duration) <= MAX_TG_VIDEO_URL_BYTES)
    .sort((a, b) => {
      const codecDiff = (b.codec === 'h264' ? 1 : 0) - (a.codec === 'h264' ? 1 : 0);
      if (codecDiff !== 0) return codecDiff;
      return (b.bitrate ?? 0) - (a.bitrate ?? 0);
    });

  const oversized = mp4s
    .filter(f => estimateVideoBytes(f, duration) > MAX_TG_VIDEO_URL_BYTES)
    .sort((a, b) => (a.bitrate ?? 0) - (b.bitrate ?? 0));

  const urls = [...fitting, ...oversized].map(f => f.url);
  if (item.url && !urls.includes(item.url)) {
    urls.push(item.url);
  }
  return urls;
}

async function callTelegramJson(
  botToken: string,
  method: string,
  payload: Record<string, unknown>
): Promise<TelegramApiResponse> {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  try {
    return (await res.json()) as TelegramApiResponse;
  } catch {
    return { ok: false, error_code: res.status, description: `HTTP ${res.status}` };
  }
}

async function callTelegramMultipart(
  botToken: string,
  method: string,
  formData: FormData
): Promise<TelegramApiResponse> {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: 'POST',
    body: formData
  });
  try {
    return (await res.json()) as TelegramApiResponse;
  } catch {
    return { ok: false, error_code: res.status, description: `HTTP ${res.status}` };
  }
}

async function fetchBinaryCapped(
  url: string,
  maxBytes: number
): Promise<{ data: ArrayBuffer; contentType: string } | null> {
  try {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) return null;
    const contentLen = res.headers.get('content-length');
    if (contentLen && /^\d+$/.test(contentLen) && Number(contentLen) > maxBytes) {
      return null;
    }
    const data = await res.arrayBuffer();
    if (data.byteLength === 0 || data.byteLength > maxBytes) {
      return null;
    }
    const contentType = res.headers.get('content-type') || 'application/octet-stream';
    return { data, contentType };
  } catch {
    return null;
  }
}

async function sendSinglePhoto(
  botToken: string,
  chatId: number,
  replyToMessageId: number,
  item: APIPhoto,
  caption: string
): Promise<boolean> {
  const photoUrl = getPhotoUrlForTelegram(item.url);
  const directRes = await callTelegramJson(botToken, 'sendPhoto', {
    chat_id: chatId,
    photo: photoUrl,
    caption,
    parse_mode: 'HTML',
    reply_parameters: { message_id: replyToMessageId }
  });
  if (directRes.ok) return true;

  console.warn('sendPhoto URL mode failed, trying byte upload fallback:', directRes.description);
  const bin = await fetchBinaryCapped(photoUrl, MAX_WORKER_UPLOAD_BYTES);
  if (!bin) return false;

  const form = new FormData();
  form.set('chat_id', String(chatId));
  form.set('caption', caption);
  form.set('parse_mode', 'HTML');
  form.set('reply_parameters', JSON.stringify({ message_id: replyToMessageId }));
  form.set('photo', new Blob([bin.data], { type: bin.contentType }), 'image.jpg');

  const uploadRes = await callTelegramMultipart(botToken, 'sendPhoto', form);
  if (!uploadRes.ok) {
    console.warn('sendPhoto byte upload failed:', uploadRes.description);
  }
  return uploadRes.ok;
}

async function sendSingleVideo(
  botToken: string,
  chatId: number,
  replyToMessageId: number,
  item: MediaItem,
  caption: string
): Promise<boolean> {
  const method = item.type === 'gif' ? 'sendAnimation' : 'sendVideo';
  const field = item.type === 'gif' ? 'animation' : 'video';
  const candidates = item.type === 'gif' ? [item.url] : pickVideoCandidates(item);
  const duration = Math.round(getMediaDuration(item));

  for (const cand of candidates.slice(0, 2)) {
    const payload: Record<string, unknown> = {
      chat_id: chatId,
      [field]: cand,
      caption,
      parse_mode: 'HTML',
      reply_parameters: { message_id: replyToMessageId }
    };
    if (item.width) payload.width = item.width;
    if (item.height) payload.height = item.height;
    if (duration > 0) payload.duration = duration;
    if (item.type === 'video') payload.supports_streaming = true;

    const res = await callTelegramJson(botToken, method, payload);
    if (res.ok) return true;
    console.warn(`${method} URL failed (${cand}):`, res.description);
  }

  const lastCand = candidates[candidates.length - 1];
  if (!lastCand) return false;
  const bin = await fetchBinaryCapped(lastCand, MAX_WORKER_UPLOAD_BYTES);
  if (!bin) return false;

  const form = new FormData();
  form.set('chat_id', String(chatId));
  form.set('caption', caption);
  form.set('parse_mode', 'HTML');
  form.set('reply_parameters', JSON.stringify({ message_id: replyToMessageId }));
  if (item.width) form.set('width', String(item.width));
  if (item.height) form.set('height', String(item.height));
  if (duration > 0) form.set('duration', String(duration));
  if (item.type === 'video') form.set('supports_streaming', 'true');
  form.set(field, new Blob([bin.data], { type: 'video/mp4' }), 'video.mp4');

  const uploadRes = await callTelegramMultipart(botToken, method, form);
  return uploadRes.ok;
}

async function sendMediaGroupChunk(
  botToken: string,
  chatId: number,
  replyToMessageId: number | undefined,
  chunk: MediaItem[],
  caption: string | undefined
): Promise<boolean> {
  const mediaEntries = chunk.map((item, idx) => {
    const mediaUrl =
      item.type === 'photo'
        ? getPhotoUrlForTelegram(item.url)
        : (pickVideoCandidates(item as APIVideo)[0] ?? item.url);
    const entry: Record<string, unknown> = {
      type: item.type === 'photo' ? 'photo' : 'video',
      media: mediaUrl
    };
    if (idx === 0 && caption) {
      entry.caption = caption;
      entry.parse_mode = 'HTML';
    }
    if (item.type !== 'photo') {
      const vid = item as APIVideo;
      if (vid.width) entry.width = vid.width;
      if (vid.height) entry.height = vid.height;
      const dur = Math.round(Number(vid.duration || 0));
      if (dur > 0) entry.duration = dur;
      entry.supports_streaming = true;
    }
    return entry;
  });

  const payload: Record<string, unknown> = {
    chat_id: chatId,
    media: mediaEntries
  };
  if (replyToMessageId !== undefined) {
    payload.reply_parameters = { message_id: replyToMessageId };
  }

  const directRes = await callTelegramJson(botToken, 'sendMediaGroup', payload);
  if (directRes.ok) return true;

  console.warn(
    'sendMediaGroup URL mode failed, trying byte upload fallback:',
    directRes.description
  );
  const form = new FormData();
  form.set('chat_id', String(chatId));
  if (replyToMessageId !== undefined) {
    form.set('reply_parameters', JSON.stringify({ message_id: replyToMessageId }));
  }

  let totalBytes = 0;
  const uploadEntries: Record<string, unknown>[] = [];
  for (let i = 0; i < chunk.length; i++) {
    const item = chunk[i]!;
    const mediaUrl =
      item.type === 'photo'
        ? getPhotoUrlForTelegram(item.url)
        : (pickVideoCandidates(item as APIVideo).slice(-1)[0] ?? item.url);
    const bin = await fetchBinaryCapped(mediaUrl, MAX_WORKER_UPLOAD_BYTES);
    if (!bin || totalBytes + bin.data.byteLength > MAX_WORKER_GROUP_TOTAL_BYTES) {
      return false;
    }
    totalBytes += bin.data.byteLength;
    const attachName = `file_${i}`;
    const ext = item.type === 'photo' ? 'jpg' : 'mp4';
    form.set(attachName, new Blob([bin.data], { type: bin.contentType }), `${attachName}.${ext}`);

    const entry: Record<string, unknown> = {
      type: item.type === 'photo' ? 'photo' : 'video',
      media: `attach://${attachName}`
    };
    if (i === 0 && caption) {
      entry.caption = caption;
      entry.parse_mode = 'HTML';
    }
    if (item.type !== 'photo') {
      const vid = item as APIVideo;
      if (vid.width) entry.width = vid.width;
      if (vid.height) entry.height = vid.height;
      const dur = Math.round(Number(vid.duration || 0));
      if (dur > 0) entry.duration = dur;
      entry.supports_streaming = true;
    }
    uploadEntries.push(entry);
  }

  form.set('media', JSON.stringify(uploadEntries));
  const uploadRes = await callTelegramMultipart(botToken, 'sendMediaGroup', form);
  if (!uploadRes.ok) {
    console.warn('sendMediaGroup byte upload failed:', uploadRes.description);
  }
  return uploadRes.ok;
}

async function replyText(
  botToken: string,
  chatId: number,
  text: string,
  options: { replyToMessageId?: number; parseMode?: 'HTML'; disableWebPreview?: boolean } = {}
): Promise<void> {
  const payload: Record<string, unknown> = {
    chat_id: chatId,
    text
  };
  if (options.parseMode) payload.parse_mode = options.parseMode;
  if (options.replyToMessageId !== undefined) {
    payload.reply_parameters = { message_id: options.replyToMessageId };
  }
  if (options.disableWebPreview) {
    payload.link_preview_options = { is_disabled: true };
  }
  const res = await callTelegramJson(botToken, 'sendMessage', payload);
  if (!res.ok) {
    console.error('sendMessage failed:', res.description);
  }
}

async function processStatusRef(
  ref: StatusRef,
  message: TelegramMessage,
  botToken: string,
  baseUrl: string,
  twitterHost: ReturnType<typeof twitterBuildHostFromContext>
): Promise<void> {
  const chatId = message.chat.id;
  const fallbackUrl = `${baseUrl}/${ref.rawPath}`;

  try {
    const thread = await constructTwitterThread(
      ref.statusId,
      false,
      twitterHost,
      undefined,
      undefined
    );
    const status = thread?.status;
    if (thread?.code !== 200 || !status || isTombstone(status)) {
      const reason = status && isTombstone(status) ? `（${status.message}）` : '';
      await replyText(botToken, chatId, `無法取得貼文內容${reason}：\n${fallbackUrl}`, {
        replyToMessageId: message.message_id
      });
      return;
    }

    const twitterStatus = status as APITwitterStatus;
    const mediaItems = collectMediaItems(twitterStatus);
    const { caption, overflowText } = buildTelegramCaption(
      twitterStatus,
      mediaItems.length > 0 ? MAX_CAPTION_LEN : MAX_TEXT_LEN
    );

    if (mediaItems.length === 0) {
      await replyText(botToken, chatId, caption, {
        replyToMessageId: message.message_id,
        parseMode: 'HTML'
      });
      return;
    }

    const action = mediaItems[0]?.type === 'photo' ? 'upload_photo' : 'upload_video';
    await callTelegramJson(botToken, 'sendChatAction', { chat_id: chatId, action });

    let ok = false;
    if (mediaItems.length === 1) {
      const only = mediaItems[0]!;
      ok =
        only.type === 'photo'
          ? await sendSinglePhoto(botToken, chatId, message.message_id, only, caption)
          : await sendSingleVideo(botToken, chatId, message.message_id, only, caption);
    } else {
      ok = true;
      for (let offset = 0; offset < mediaItems.length; offset += 10) {
        const chunk = mediaItems.slice(offset, offset + 10);
        const chunkOk = await sendMediaGroupChunk(
          botToken,
          chatId,
          offset === 0 ? message.message_id : undefined,
          chunk,
          offset === 0 ? caption : undefined
        );
        if (!chunkOk) {
          ok = false;
          break;
        }
      }
    }

    if (!ok) {
      await replyText(botToken, chatId, `原生傳送媒體失敗，改附代理連結：\n${fallbackUrl}`, {
        replyToMessageId: message.message_id
      });
      return;
    }

    if (overflowText) {
      await replyText(botToken, chatId, overflowText, {
        replyToMessageId: message.message_id,
        parseMode: 'HTML',
        disableWebPreview: true
      });
    }
  } catch (err) {
    console.error('processStatusRef failed:', err);
    await replyText(botToken, chatId, `處理貼文時發生錯誤，改附代理連結：\n${fallbackUrl}`, {
      replyToMessageId: message.message_id
    });
  }
}

async function handleTelegramMessage(
  message: TelegramMessage,
  botToken: string,
  baseUrl: string,
  twitterHost: ReturnType<typeof twitterBuildHostFromContext>
): Promise<void> {
  const rawText = (message.text ?? message.caption ?? '').trim();
  const cmdMatch = rawText.match(/^\/([a-zA-Z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/);

  if (cmdMatch) {
    const cmd = (cmdMatch[1] ?? '').toLowerCase();
    const args = (cmdMatch[2] ?? '').trim();

    if (cmd === 'start') {
      await replyText(
        botToken,
        message.chat.id,
        '已連線到私人 FxEmbed（Cloudflare Worker 24 小時原生發圖模式）！\n' +
          '• 直接傳送 x.com / twitter.com 連結 → 直接發送圖片 / 多圖相簿 / 影片與貼文\n' +
          '• /link <連結> → 僅轉換為私人預覽連結\n' +
          '• /d <連結> → 取得直連圖片網址 (.jpg?name=large)',
        { replyToMessageId: message.message_id }
      );
      return;
    }

    if (cmd === 'link' || cmd === 'l' || cmd === 'd') {
      const sourceText =
        args || message.reply_to_message?.text || message.reply_to_message?.caption || '';
      const refs = extractStatusRefs(sourceText, args ? undefined : message.reply_to_message);
      if (refs.length === 0) {
        await replyText(
          botToken,
          message.chat.id,
          `請在 /${cmd} 後面加上 X 貼文連結，或回覆一則包含連結的訊息。`,
          { replyToMessageId: message.message_id }
        );
        return;
      }
      const suffix = cmd === 'd' ? '.jpg?name=large' : '';
      const links = refs.map(r => `${baseUrl}/${r.rawPath}${suffix}`);
      await replyText(botToken, message.chat.id, links.join('\n'), {
        replyToMessageId: message.message_id
      });
      return;
    }
    return;
  }

  const refs = extractStatusRefs(rawText, message);
  for (const ref of refs) {
    await processStatusRef(ref, message, botToken, baseUrl, twitterHost);
  }
}

export const telegramWebhook = async (
  c: Context<{ Bindings: WorkerBindings }>
): Promise<Response> => {
  const botToken = c.env?.TG_BOT_TOKEN?.trim();
  const expectedSecret = c.env?.TG_WEBHOOK_SECRET?.trim();
  if (!botToken || !expectedSecret) {
    return c.json({ ok: false, error: 'Telegram webhook is not configured' }, 503);
  }

  const providedSecret = c.req.header('X-Telegram-Bot-Api-Secret-Token') ?? '';
  if (!timingSafeEqualStrings(providedSecret, expectedSecret)) {
    return c.json({ ok: false, error: 'Unauthorized' }, 401);
  }

  let update: TelegramUpdate;
  try {
    update = (await c.req.json()) as TelegramUpdate;
  } catch {
    return c.json({ ok: false, error: 'Invalid JSON' }, 400);
  }

  const message = update.message;
  if (!message || !message.chat?.id) {
    return c.json({ ok: true });
  }

  const allowedUsers = parseAllowedUsers(c.env?.TG_ALLOWED_USERS);
  if (allowedUsers.size > 0) {
    const uid = message.from?.id !== undefined ? String(message.from.id) : '';
    if (!uid || !allowedUsers.has(uid)) {
      console.log(`Ignored unauthorized Telegram user: ${uid || 'unknown'}`);
      return c.json({ ok: true });
    }
  }

  const reqUrl = new URL(c.req.url);
  const baseUrl = `${reqUrl.protocol}//${reqUrl.host}`;
  const twitterHost = twitterBuildHostFromContext(c);

  const work = handleTelegramMessage(message, botToken, baseUrl, twitterHost).catch(err => {
    console.error('Unhandled Telegram webhook error:', err);
  });

  let scheduled = false;
  try {
    c.executionCtx.waitUntil(work);
    scheduled = true;
  } catch {
    // No ExecutionContext in direct unit tests; await inline below.
  }
  if (!scheduled) {
    await work;
  }

  return c.json({ ok: true });
};
