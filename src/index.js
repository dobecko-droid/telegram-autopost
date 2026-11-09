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

      if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TELEGRAM_WEBHOOK_SECRET) {
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
  const message = update?.message;
  if (!message?.chat?.id) return;

  // Optional safety lock: when configured, only this Telegram user may submit links.
  if (env.TELEGRAM_ALLOWED_USER_ID && String(message.from?.id) !== String(env.TELEGRAM_ALLOWED_USER_ID)) {
    return;
  }

  const text = message.text || message.caption || "";

  if (text.startsWith("/start") || text.startsWith("/help")) {
    await sendTelegram(env, message.chat.id,
      "Привет! Отправь ссылку на TikTok-видео — я добавлю её в очередь. Команда /queue покажет количество принятых ссылок.");
    return;
  }

  if (text.startsWith("/queue")) {
    const result = await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM videos WHERE status IN ('queued', 'processing', 'ready', 'scheduled')"
    ).first();
    await sendTelegram(env, message.chat.id, `📥 В очереди: ${result?.total ?? 0}`);
    return;
  }

  const match = text.match(TIKTOK_URL_RE);
  if (!match) {
    await sendTelegram(env, message.chat.id, "Пришли, пожалуйста, обычную ссылку на видео TikTok.");
    return;
  }

  const tiktokUrl = match[0].replace(/[),.!?]+$/, "");
  const result = await env.DB.prepare(
    "INSERT OR IGNORE INTO videos (tiktok_url, status, source_chat_id, source_message_id) VALUES (?, 'queued', ?, ?)"
  ).bind(tiktokUrl, String(message.chat.id), String(message.message_id || "")).run();

  if (result.meta?.changes) {
    await sendTelegram(env, message.chat.id,
      "✅ Ссылка принята и добавлена в очередь. Сейчас бот сохраняет ссылки; загрузка видео и автопубликация ещё не подключены.");
  } else {
    await sendTelegram(env, message.chat.id,
      "ℹ️ Эта ссылка уже была добавлена. Повторно её не добавляю.");
  }
}

async function sendTelegram(env, chatId, text) {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text })
  });

  if (!response.ok) {
    throw new Error(`Telegram sendMessage failed: ${response.status} ${await response.text()}`);
  }
}
