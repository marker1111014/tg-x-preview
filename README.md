# tg-x-preview

私人自架 X（Twitter）貼文與媒體在 Telegram 的完整解決方案，整合兩部分：

1. **私人自架 [FxEmbed](https://github.com/FxEmbed/FxEmbed) Cloudflare Workers 代理節點**：
   - 使用自己的 X 帳號 Cookie 加密打包，避免公共代理池封鎖與 UK / EU / AU 年齡限制（`NsfwViewerIsUnderage`）。
   - 修正 Telegram 單圖預覽 `og:image`（[photo.ts](FxEmbed/src/render/photo.ts)），由 `?name=orig` 改為 `?name=large`，避免超過 Telegram 預覽爬蟲大小上限導致只顯示文字不顯示圖片。
   - 開放同網域 `/2/status/:id` API 路由與新增內建 **Telegram Webhook（`POST /tg-webhook`）**（[webhook.ts](FxEmbed/src/realms/telegram/webhook.ts)）。
2. **Telegram Bot（兩種執行模式）**：
   - **24 小時免伺服器模式（推薦）**：直接由 Cloudflare Worker 透過 Webhook 接收 Telegram 訊息並即時回傳原生圖片／多圖相簿／影片與貼文內容。
   - **本機 Polling 備用模式**：使用 [my_fx_bot.py](my_fx_bot.py) 在本機或自架主機常駐執行。

---

## 目錄結構

- `FxEmbed/`：基於上游 `FxEmbed/FxEmbed`（MIT License，詳見 [FxEmbed/LICENSE.md](FxEmbed/LICENSE.md)）客製化後的 Cloudflare Worker 原始碼。
- `my_fx_bot.py`：本機／自架主機用的 Python Telegram Polling Bot。
- `.env.bot.example` / `requirements.txt`：Python Bot 環境設定範本與相依套件清單。

---

## 快速部署：Cloudflare Workers 一條龍版（24 小時運行）

### 1. 事前準備

- Node.js（建議 v22 / v24+）與 `git`
- Cloudflare 帳號（Workers 免費版每天 10 萬次請求）
- Telegram Bot Token（向 `@BotFather` 建立）
- 1～2 個健康的 X 小號 Cookie（地區建議非 UK / EU / AU、年齡設定滿 18 歲、隱私設定勾選「顯示可能包含敏感內容的媒體」）

### 2. 安裝依賴與加密 X 憑證

```bash
cd FxEmbed
npm install
```

建立 `FxEmbed/credentials.json`（參考 `credentials.example.json`，**切勿提交到公開 Git**）：

```json
{
  "twitter": {
    "accounts": [
      {
        "authToken": "你的_auth_token",
        "csrfToken": "你的_ct0",
        "username": "你的小號帳號ID_不含小老鼠"
      }
    ]
  }
}
```

產生加密憑證與金鑰（若沒填 `csrfToken`，可先執行 `npm run credentials:add-csrf`）：

```bash
npm run credentials:encrypt
```

### 3. 設定 `.env` 與 `wrangler.toml`

```bash
cp .env.example .env
cp wrangler.example.toml wrangler.toml
```

編輯 `FxEmbed/.env` 的關鍵設定：

```ini
# 若使用免費 *.workers.dev 網域，務必加入 workers.dev
STANDARD_DOMAIN_LIST = "workers.dev,fxtwitter.com,fixupx.com,twittpr.com"

# 讓 Telegram 直接向 Twitter 官方圖片伺服器抓圖，不經過公共 pbs 代理
PBS_PROXY_DOMAIN_LIST = ""

# 不可留空，避免影片直連轉向組成錯誤網址
API_HOST_LIST = "api.fxtwitter.com"
```

編輯 `FxEmbed/wrangler.toml`，填入你的 Cloudflare `account_id`（若未啟用 Analytics Engine，移除 `analytics_engine_datasets` 區段）：

```toml
name = "my-fxembed"
account_id = "填入你的_CLOUDFLARE_ACCOUNT_ID"
main = "./dist/worker.js"
compatibility_date = "2026-04-11"
send_metrics = false

[build]
command = "npm run build"
```

### 4. 上傳 Secrets 並部署 Worker

```bash
npx wrangler login

# 1. X 憑證解密金鑰（貼上 .credential-key 內容）
npx wrangler secret put CREDENTIAL_KEY

# 2. Telegram Bot Token 與 Webhook 驗證密鑰
npx wrangler secret put TG_BOT_TOKEN
npx wrangler secret put TG_WEBHOOK_SECRET

# 3. 強烈建議：限定允許使用的 Telegram User ID（逗號分隔，可用 @userinfobot 查詢）
npx wrangler secret put TG_ALLOWED_USERS

npm run build
npm run deploy
```

### 5. 註冊 Telegram Webhook

將 `<BOT_TOKEN>`、`<YOUR_SUBDOMAIN>` 與 `<TG_WEBHOOK_SECRET>` 替換為實際值後執行一次：

```bash
curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://my-fxembed.<YOUR_SUBDOMAIN>.workers.dev/tg-webhook",
    "secret_token": "<TG_WEBHOOK_SECRET>",
    "allowed_updates": ["message"],
    "drop_pending_updates": true
  }'
```

---

## Bot 指令說明

- 直接傳送 `x.com` / `twitter.com` 貼文連結：自動回覆原生圖片、多圖相簿、影片或純文字預覽。
- `/link <連結>`（或 `/l`）：僅回傳改寫後的自架預覽網址。
- `/d <連結>`：回傳 `.jpg?name=large` 直連圖片轉向網址。

---

## 備用方案：本機 / VPS 執行 Python Polling Bot

> 注意：Telegram 同一個 Bot Token 不能同時啟用 Webhook 與 `run_polling()`；若改用本機 Polling，請先呼叫 `deleteWebhook`。

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.bot.example .env.bot
# 編輯 .env.bot 填入 BOT_TOKEN、MY_FX_BASE 與 ALLOWED_USERS
.venv/bin/python my_fx_bot.py
```

---

## 授權與致謝

- `FxEmbed/` 目錄源自 [FxEmbed/FxEmbed](https://github.com/FxEmbed/FxEmbed)，依 MIT License 授權（見 [FxEmbed/LICENSE.md](FxEmbed/LICENSE.md)）。
