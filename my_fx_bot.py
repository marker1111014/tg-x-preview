import asyncio
import html
import io
import logging
import os
import re
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

import httpx
from telegram import InputMediaPhoto, InputMediaVideo, Update
from telegram.constants import ChatAction, ParseMode
from telegram.error import TelegramError
from telegram.ext import ApplicationBuilder, CommandHandler, ContextTypes, MessageHandler, filters

logging.basicConfig(
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger("my_fx_bot")

MAX_PHOTO_UPLOAD_BYTES = 9_500_000
MAX_VIDEO_UPLOAD_BYTES = 48_000_000
MAX_CAPTION_LEN = 1024
MAX_TEXT_LEN = 4096
HTTP_TIMEOUT = 25.0
USER_AGENT = "MyFxBot/1.0 (+https://github.com/FxEmbed/FxEmbed)"

X_STATUS_RE = re.compile(
    r"https?://(?:www\.|mobile\.)?(?:x\.com|twitter\.com|fxtwitter\.com|fixupx\.com|twittpr\.com)/"
    r"((?:i/web|[A-Za-z0-9_]+)/status(?:es)?/(\d+))(?:\S*)",
    re.IGNORECASE,
)


def load_env_file(path: Path) -> None:
    if not path.is_file():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'"):
            value = value[1:-1]
        if key and key not in os.environ:
            os.environ[key] = value


load_env_file(Path(__file__).with_name(".env.bot"))

BOT_TOKEN = os.environ.get("BOT_TOKEN", "").strip()
MY_FX_BASE = os.environ.get("MY_FX_BASE", "https://my-fxembed.yourname.workers.dev").strip().rstrip("/")
ALLOWED_USERS = {
    int(uid.strip())
    for uid in os.environ.get("ALLOWED_USERS", "").split(",")
    if uid.strip().isdigit()
}


def is_authorized(update: Update) -> bool:
    if not ALLOWED_USERS:
        return True
    user = update.effective_user
    return user is not None and user.id in ALLOWED_USERS


def extract_status_refs(text: str, message: Any = None) -> list[tuple[str, str]]:
    """Return deduplicated list of (normalized_path, status_id) tuples."""
    sources = [text] if text else []
    if message is not None:
        for ent in list(message.entities or []) + list(message.caption_entities or []):
            if getattr(ent, "url", None):
                sources.append(ent.url)

    refs: list[tuple[str, str]] = []
    seen_ids: set[str] = set()
    for src in sources:
        for match in X_STATUS_RE.finditer(src):
            raw_path, status_id = match.group(1), match.group(2)
            if raw_path.lower().startswith("i/web/"):
                raw_path = raw_path[6:]
            raw_path = re.sub(r"/statuses/", "/status/", raw_path, flags=re.IGNORECASE)
            if status_id not in seen_ids:
                seen_ids.add(status_id)
                refs.append((raw_path, status_id))
    return refs


def with_query_param(url: str, key: str, value: str) -> str:
    parsed = urlparse(url)
    params = dict(parse_qsl(parsed.query, keep_blank_values=True))
    params[key] = value
    return urlunparse(parsed._replace(query=urlencode(params)))


def build_caption(status: dict[str, Any], limit: int = MAX_CAPTION_LEN) -> tuple[str, str | None]:
    """Build Telegram HTML caption safely within limit; return (caption, overflow_text)."""
    author = status.get("author") or {}
    name = html.escape(author.get("name") or "Unknown")
    screen_name = html.escape(author.get("screen_name") or "i")
    post_url = html.escape(status.get("url") or f"https://x.com/{screen_name}/status/{status.get('id', '')}")

    header = f'<b>{name}</b> (<a href="{post_url}">@{screen_name}</a>)'
    raw_text = (status.get("text") or "").strip()

    quote = status.get("quote")
    quote_block = ""
    if isinstance(quote, dict) and quote.get("type") != "tombstone":
        q_author = quote.get("author") or {}
        q_handle = q_author.get("screen_name") or ""
        q_text = (quote.get("text") or "").strip()
        if q_handle or q_text:
            snippet = q_text if len(q_text) <= 220 else q_text[:217] + "…"
            quote_block = f"\n\n<blockquote>↪ @{html.escape(q_handle)}: {html.escape(snippet)}</blockquote>"

    if not raw_text and not quote_block:
        return header, None

    full_body = f"\n\n{html.escape(raw_text)}" if raw_text else ""
    full_msg = f"{header}{full_body}{quote_block}"
    if len(full_msg) <= limit:
        return full_msg, None

    # Truncate plain raw_text cleanly before escaping so HTML entities are never split.
    reserved = len(header) + len(quote_block) + 8
    avail = max(40, limit - reserved)
    truncated = raw_text[:avail]
    while truncated and len(f"{header}\n\n{html.escape(truncated)}…{quote_block}") > limit:
        truncated = truncated[:-10] if len(truncated) > 20 else truncated[:-1]
    short_msg = f"{header}\n\n{html.escape(truncated)}…{quote_block}"
    if len(short_msg) > limit:
        short_msg = header
    return short_msg, full_msg[:MAX_TEXT_LEN]


STATIC_IMAGE_EXT_RE = re.compile(r"\.(?:jpe?g|png|webp|avif|bmp)$", re.IGNORECASE)


def is_static_image_url(url: str) -> bool:
    if not url:
        return False
    parsed = urlparse(url)
    host = parsed.hostname.lower() if parsed.hostname else ""
    path = parsed.path.lower()
    if host == "pbs.twimg.com" and "/tweet_video_thumb/" in path:
        return True
    return bool(STATIC_IMAGE_EXT_RE.search(path))


def detect_media_kind(data: bytes, content_type: str = "") -> str:
    if len(data) >= 6 and data[:6] in (b"GIF87a", b"GIF89a"):
        return "gif"
    if len(data) >= 12 and data[4:8] == b"ftyp":
        return "mp4"
    if len(data) >= 3 and data[:3] == b"\xff\xd8\xff":
        return "jpeg"
    if len(data) >= 4 and data[:4] == b"\x89PNG":
        return "png"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"

    ct = content_type.split(";")[0].strip().lower()
    if ct == "image/gif":
        return "gif"
    if ct in ("video/mp4", "video/webm"):
        return "mp4"
    if ct in ("image/jpeg", "image/jpg"):
        return "jpeg"
    if ct == "image/png":
        return "png"
    if ct == "image/webp":
        return "webp"
    if ct.startswith("image/"):
        return "other_image"
    return "unknown"


async def fetch_bytes_with_type(
    client: httpx.AsyncClient, url: str, max_bytes: int
) -> tuple[bytes, str] | None:
    try:
        async with client.stream("GET", url, follow_redirects=True) as resp:
            if resp.status_code != 200:
                logger.warning("Fetch media failed %s -> HTTP %s", url, resp.status_code)
                return None
            content_len = resp.headers.get("content-length")
            if content_len and content_len.isdigit() and int(content_len) > max_bytes:
                logger.info("Media too large (%s bytes > %s): %s", content_len, max_bytes, url)
                return None
            buf = bytearray()
            async for chunk in resp.aiter_bytes(65536):
                buf.extend(chunk)
                if len(buf) > max_bytes:
                    logger.info("Stream exceeded %s bytes: %s", max_bytes, url)
                    return None
            content_type = resp.headers.get("content-type", "")
            return bytes(buf), content_type
    except httpx.HTTPError as exc:
        logger.warning("HTTP error fetching %s: %s", url, exc)
        return None


async def fetch_bytes(client: httpx.AsyncClient, url: str, max_bytes: int) -> bytes | None:
    res = await fetch_bytes_with_type(client, url, max_bytes)
    return res[0] if res is not None else None


async def fetch_photo_file(client: httpx.AsyncClient, item: dict[str, Any]) -> io.BytesIO | str:
    url = item.get("url") or ""
    width = int(item.get("width") or 0)
    height = int(item.get("height") or 0)
    is_twitter_pbs = "pbs.twimg.com/media/" in url

    candidates: list[str] = []
    if is_twitter_pbs:
        large_url = with_query_param(url, "name", "large")
        # Telegram rejects photos with width+height > 10000 or huge files; prefer orig only when reasonable.
        if width and height and (width + height) <= 8000 and max(width, height) <= 3000:
            candidates.extend([url, large_url])
        else:
            candidates.extend([large_url, url])
    else:
        candidates.append(url)

    for cand in candidates:
        data = await fetch_bytes(client, cand, MAX_PHOTO_UPLOAD_BYTES)
        if data:
            bio = io.BytesIO(data)
            bio.name = "image.jpg"
            return bio

    return candidates[0]


def pick_video_candidates(item: dict[str, Any]) -> list[str]:
    formats = [
        f for f in (item.get("formats") or [])
        if isinstance(f, dict) and f.get("container") == "mp4" and f.get("url")
    ]
    # Prefer h264 MP4 sorted from highest bitrate down so we get best quality that fits <= 48 MB.
    formats.sort(
        key=lambda f: (1 if f.get("codec") == "h264" else 0, int(f.get("bitrate") or 0)),
        reverse=True,
    )
    urls: list[str] = []
    for fmt in formats:
        furl = fmt["url"]
        if not is_static_image_url(furl) and furl not in urls:
            urls.append(furl)

    item_url = item.get("url") or ""
    if item_url and not is_static_image_url(item_url) and item_url not in urls:
        urls.append(item_url)

    transcode_url = item.get("transcode_url") or ""
    if (
        item.get("type") == "gif"
        and transcode_url
        and not is_static_image_url(transcode_url)
        and transcode_url not in urls
    ):
        urls.append(transcode_url)
    return urls


async def fetch_video_file(client: httpx.AsyncClient, item: dict[str, Any]) -> io.BytesIO | str | None:
    candidates = pick_video_candidates(item)
    for cand in candidates:
        fetched = await fetch_bytes_with_type(client, cand, MAX_VIDEO_UPLOAD_BYTES)
        if not fetched:
            continue
        data, content_type = fetched
        kind = detect_media_kind(data, content_type)
        if kind in ("jpeg", "png", "webp", "other_image"):
            logger.warning("Rejected static image (%s) for %s from %s", kind, item.get("type"), cand)
            continue
        bio = io.BytesIO(data)
        bio.name = "animation.gif" if kind == "gif" else "video.mp4"
        return bio
    return candidates[0] if candidates else None


async def fetch_status_json(client: httpx.AsyncClient, status_id: str) -> dict[str, Any] | None:
    api_url = f"{MY_FX_BASE}/2/status/{status_id}"
    try:
        resp = await client.get(api_url, headers={"User-Agent": USER_AGENT}, follow_redirects=True)
        if resp.status_code != 200:
            logger.warning("API %s returned HTTP %s: %s", api_url, resp.status_code, resp.text[:200])
            return None
        return resp.json()
    except (httpx.HTTPError, ValueError) as exc:
        logger.warning("Failed fetching API %s: %s", api_url, exc)
        return None


def collect_media_items(status: dict[str, Any]) -> list[dict[str, Any]]:
    media = status.get("media") or {}
    items = [m for m in (media.get("all") or []) if m.get("type") in ("photo", "video", "gif")]
    if not items:
        quote = status.get("quote")
        if isinstance(quote, dict) and quote.get("type") != "tombstone":
            q_media = quote.get("media") or {}
            items = [m for m in (q_media.get("all") or []) if m.get("type") in ("photo", "video", "gif")]
    return items


async def send_status_to_chat(
    update: Update,
    client: httpx.AsyncClient,
    raw_path: str,
    status_id: str,
) -> None:
    msg = update.message
    if not msg:
        return

    fallback_url = f"{MY_FX_BASE}/{raw_path}"
    payload = await fetch_status_json(client, status_id)
    status = payload.get("status") if isinstance(payload, dict) else None

    if not isinstance(status, dict) or status.get("type") == "tombstone":
        err_msg = status.get("message") if isinstance(status, dict) else None
        text = f"無法取得貼文內容（{err_msg}）：{fallback_url}" if err_msg else fallback_url
        await msg.reply_text(text, reply_to_message_id=msg.message_id)
        return

    media_items = collect_media_items(status)
    caption, overflow_text = build_caption(status, MAX_CAPTION_LEN if media_items else MAX_TEXT_LEN)

    try:
        if not media_items:
            await msg.reply_text(
                caption,
                parse_mode=ParseMode.HTML,
                reply_to_message_id=msg.message_id,
            )
            return

        if len(media_items) == 1:
            item = media_items[0]
            mtype = item.get("type")
            if mtype == "photo":
                await msg.chat.send_action(ChatAction.UPLOAD_PHOTO)
                photo_input = await fetch_photo_file(client, item)
                await msg.reply_photo(
                    photo=photo_input,
                    caption=caption,
                    parse_mode=ParseMode.HTML,
                    reply_to_message_id=msg.message_id,
                )
            elif mtype == "gif":
                await msg.chat.send_action(ChatAction.UPLOAD_VIDEO)
                gif_input = await fetch_video_file(client, item)
                if not gif_input:
                    await msg.reply_text(fallback_url, reply_to_message_id=msg.message_id)
                    return
                await msg.reply_animation(
                    animation=gif_input,
                    caption=caption,
                    parse_mode=ParseMode.HTML,
                    width=item.get("width"),
                    height=item.get("height"),
                    duration=int(item.get("duration") or 0) or None,
                    reply_to_message_id=msg.message_id,
                )
            else:
                await msg.chat.send_action(ChatAction.UPLOAD_VIDEO)
                vid_input = await fetch_video_file(client, item)
                if not vid_input:
                    await msg.reply_text(fallback_url, reply_to_message_id=msg.message_id)
                    return
                await msg.reply_video(
                    video=vid_input,
                    caption=caption,
                    parse_mode=ParseMode.HTML,
                    width=item.get("width"),
                    height=item.get("height"),
                    duration=int(item.get("duration") or 0) or None,
                    supports_streaming=True,
                    reply_to_message_id=msg.message_id,
                )
        else:
            await msg.chat.send_action(ChatAction.UPLOAD_PHOTO)
            tasks = [
                fetch_photo_file(client, it) if it.get("type") == "photo" else fetch_video_file(client, it)
                for it in media_items
            ]
            fetched = await asyncio.gather(*tasks)

            group: list[InputMediaPhoto | InputMediaVideo] = []
            for idx, (item, media_data) in enumerate(zip(media_items, fetched)):
                if not media_data:
                    continue
                item_caption = caption if idx == 0 else None
                item_parse = ParseMode.HTML if idx == 0 else None
                if item.get("type") == "photo":
                    group.append(
                        InputMediaPhoto(media=media_data, caption=item_caption, parse_mode=item_parse)
                    )
                else:
                    group.append(
                        InputMediaVideo(
                            media=media_data,
                            caption=item_caption,
                            parse_mode=item_parse,
                            width=item.get("width"),
                            height=item.get("height"),
                            duration=int(item.get("duration") or 0) or None,
                            supports_streaming=True,
                        )
                    )

            if not group:
                await msg.reply_text(fallback_url, reply_to_message_id=msg.message_id)
                return

            # Telegram allows up to 10 items per media group.
            for offset in range(0, len(group), 10):
                chunk = group[offset : offset + 10]
                await msg.reply_media_group(
                    media=chunk,
                    reply_to_message_id=msg.message_id if offset == 0 else None,
                )

        if overflow_text:
            await msg.reply_text(
                overflow_text,
                parse_mode=ParseMode.HTML,
                disable_web_page_preview=True,
                reply_to_message_id=msg.message_id,
            )
    except TelegramError as exc:
        logger.exception("Telegram send failed for %s: %s", status_id, exc)
        await msg.reply_text(
            f"原生傳送媒體失敗，改附代理連結：\n{fallback_url}",
            reply_to_message_id=msg.message_id,
        )


async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not is_authorized(update) or not update.message:
        return
    await update.message.reply_text(
        "已連線到私人 FxEmbed（原生發圖模式）！\n"
        "• 直接傳送 x.com / twitter.com 連結 → 直接發送圖片 / 多圖相簿 / 影片與貼文\n"
        "• /link <連結> → 僅轉換為私人預覽連結\n"
        "• /d <連結> → 取得直連圖片網址 (.jpg?name=large)"
    )


async def cmd_link(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not is_authorized(update) or not update.message:
        return
    raw_text = " ".join(context.args) if context.args else (
        update.message.reply_to_message.text or "" if update.message.reply_to_message else ""
    )
    refs = extract_status_refs(raw_text, update.message.reply_to_message)
    if not refs:
        await update.message.reply_text("請在 /link 後面加上 X 貼文連結，或回覆一則包含連結的訊息。")
        return
    await update.message.reply_text("\n".join(f"{MY_FX_BASE}/{path}" for path, _ in refs))


async def cmd_direct(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not is_authorized(update) or not update.message:
        return
    raw_text = " ".join(context.args) if context.args else (
        update.message.reply_to_message.text or "" if update.message.reply_to_message else ""
    )
    refs = extract_status_refs(raw_text, update.message.reply_to_message)
    if not refs:
        await update.message.reply_text("請在 /d 後面加上 X 貼文連結，或回覆一則包含連結的訊息。")
        return
    await update.message.reply_text("\n".join(f"{MY_FX_BASE}/{path}.jpg?name=large" for path, _ in refs))


async def on_message(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not is_authorized(update) or not update.message:
        return
    text = update.message.text or update.message.caption or ""
    refs = extract_status_refs(text, update.message)
    if not refs:
        return

    client: httpx.AsyncClient = context.bot_data["http_client"]
    for raw_path, status_id in refs:
        await send_status_to_chat(update, client, raw_path, status_id)


async def post_init(application: Any) -> None:
    application.bot_data["http_client"] = httpx.AsyncClient(timeout=HTTP_TIMEOUT)


async def post_shutdown(application: Any) -> None:
    client: httpx.AsyncClient | None = application.bot_data.get("http_client")
    if client is not None:
        await client.aclose()


def main() -> None:
    if not BOT_TOKEN or "填入" in BOT_TOKEN:
        raise SystemExit("請先設定 BOT_TOKEN（可寫入 .env.bot 或使用 export BOT_TOKEN=...）")
    if not ALLOWED_USERS:
        logger.warning("ALLOWED_USERS 未設定，目前任何知道 Bot 的使用者都能觸發查詢。")

    app = (
        ApplicationBuilder()
        .token(BOT_TOKEN)
        .post_init(post_init)
        .post_shutdown(post_shutdown)
        .build()
    )
    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(CommandHandler(["link", "l"], cmd_link))
    app.add_handler(CommandHandler("d", cmd_direct))
    app.add_handler(MessageHandler((filters.TEXT | filters.CAPTION) & ~filters.COMMAND, on_message))
    logger.info("Bot 啟動完成，代理端點：%s", MY_FX_BASE)
    app.run_polling()


if __name__ == "__main__":
    main()
