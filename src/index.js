const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const TIKTOK_URL_RE = /https?:\/\/(?:www\.|vm\.|vt\.)?tiktok\.com\/[^\s]+/i;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true, service: "telegram-autopost" });
    }

    if (request.method === "POST" && url.pathname === "/webhook") {
      if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET || !env.DB) {
        return Response.json({ ok: false, error: "Worker is missing required configuration" }, { status: 500 });
      }

      const suppliedSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (suppliedSecret !== env.TELEGRAM_WEBHOOK_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }

      let update;
      try {
        update = await request.json();
      } catch {
        return new Response("Bad JSON", { status: 400 });
      }

      try {
        await handleUpdate(update, env);
        return new Response("OK");
      } catch (error) {
        console.error("Webhook processing failed:", error);
        return new Response("Processing error", { status: 500 });
      }
    }

    return Response.json({ ok: false, error: "Not found" }, { status: 404 });
  }
};

async function handleUpdate(update, env) {
  const message = update?.message || update?.channel_post;
  if (!message?.chat?.id) return;

  const text = message.text || message.caption || "";
  const match = text.match(TIKTOK_URL_RE);

  if (!match) {
    if (text.startsWith("/start")) {
      await sendTelegram(env, message.chat.id,
        "Привет! Отправь мне ссылку на TikTok-видео. Я добавлю её в очередь и сообщу результат.");
    }
    return;
  }

  const tiktokUrl = match[0].replace(/[),.!?]+$/, "");
  const result = await env.DB.prepare(
    "INSERT OR IGNORE INTO videos (tiktok_url, status, source_chat_id, source_message_id) VALUES (?, 'queued', ?, ?)"
  ).bind(tiktokUrl, String(message.chat.id), String(message.message_id || "")).run();

  if (result.meta?.changes) {
    await sendTelegram(env, message.chat.id,
      "✅ Ссылка добавлена в очередь. Пока это только приём ссылки — загрузчик TikTok и автоматическая публикация ещё настраиваются.");
  } else {
    await sendTelegram(env, message.chat.id,
      "ℹ️ Эта ссылка уже есть в очереди или была обработана ранее. Повторно добавлять её не буду.");
  }
}

async function sendTelegram(env, chatId, text) {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text })
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Telegram sendMessage failed: ${response.status} ${details}`);
  }
}
