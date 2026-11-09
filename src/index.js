const TIKTOK_URL_RE = /https?:\/\/(?:www\.|vm\.|vt\.)?tiktok\.com\/[^\s]+/i;
const TIME_ZONE = "Asia/Tashkent";
const DAILY_TIMES = [[10, 0], [15, 0], [20, 0]];

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
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runSchedule(env));
  }
};

async function handleUpdate(update, env) {
  const message = update?.message;
  if (!message?.chat?.id) return;

  if (env.TELEGRAM_ALLOWED_USER_ID && String(message.from?.id) !== String(env.TELEGRAM_ALLOWED_USER_ID)) {
    return;
  }

  const text = message.text || message.caption || "";

  if (text.startsWith("/start") || text.startsWith("/help")) {
    await sendTelegram(env, message.chat.id,
      "Привет! Отправь ссылку на TikTok-видео — я добавлю её в очередь. Команда /queue покажет количество ссылок.");
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
    await sendTelegram(env, message.chat.id, "Пришли, пожалуйста, ссылку на видео TikTok.");
    return;
  }

  const tiktokUrl = match[0].replace(/[),.!?]+$/, "");
  const result = await env.DB.prepare(
    "INSERT OR IGNORE INTO videos (tiktok_url, status, source_chat_id, source_message_id) VALUES (?, 'queued', ?, ?)"
  ).bind(tiktokUrl, String(message.chat.id), String(message.message_id || "")).run();

  if (result.meta?.changes) {
    await sendTelegram(env, message.chat.id,
      "✅ Ссылка принята и добавлена в очередь. Следующий этап — подключение загрузчика TikTok.");
  } else {
    await sendTelegram(env, message.chat.id, "ℹ️ Эта ссылка уже была добавлена. Повторно её не добавляю.");
  }
}

async function runSchedule(env) {
  if (!env.DB || !env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHANNEL) {
    console.error("Scheduler is missing DB, TELEGRAM_BOT_TOKEN, or TELEGRAM_CHANNEL");
    return;
  }

  await processQueuedVideos(env);
  await assignPublicationSlots(env);
  await publishDueVideos(env);
}


async function resolveTikTokVideo(tiktokUrl) {
  const apiUrl = new URL("https://clipx.zamdev.workers.dev/");
  apiUrl.searchParams.set("url", tiktokUrl);
  apiUrl.searchParams.set("quality", "best");
  apiUrl.searchParams.set("audio", "true");
  apiUrl.searchParams.set("cover", "false");
  apiUrl.searchParams.set("metadata", "false");

  const response = await fetch(apiUrl.toString(), {
    headers: { "accept": "application/json" },
    signal: AbortSignal.timeout(60000)
  });
  if (!response.ok) throw new Error(`TikTok service returned HTTP ${response.status}`);

  const payload = await response.json();
  if (!payload?.success || !payload?.data) {
    throw new Error(payload?.error || "TikTok service could not process this link");
  }
  const videoUrl = payload.data.video?.hd_mp4 ||
    payload.data.video?.standard_mp4 || payload.data.video?.wmplay;
  if (!videoUrl || !/^https:\/\//i.test(videoUrl)) {
    throw new Error("TikTok service did not return a usable MP4 URL");
  }
  return videoUrl;
}

async function processQueuedVideos(env) {
  // ClipX currently documents a no-key endpoint with a 10 requests/minute
  // and 100 requests/day limit. Process one link per cron run to stay gentle.
  const item = await env.DB.prepare(
    "SELECT id, tiktok_url FROM videos WHERE status = 'queued' ORDER BY submitted_at, id LIMIT 1"
  ).first();
  if (!item) return;

  await env.DB.prepare(
    "UPDATE videos SET status = 'processing', error_message = NULL WHERE id = ? AND status = 'queued'"
  ).bind(item.id).run();

  try {
    const apiUrl = new URL("https://clipx.zamdev.workers.dev/");
    apiUrl.searchParams.set("url", item.tiktok_url);
    apiUrl.searchParams.set("quality", "best");
    apiUrl.searchParams.set("audio", "true");
    apiUrl.searchParams.set("cover", "false");
    apiUrl.searchParams.set("metadata", "false");

    const response = await fetch(apiUrl.toString(), {
      headers: { "accept": "application/json" },
      signal: AbortSignal.timeout(60000)
    });
    if (!response.ok) throw new Error(`TikTok service returned HTTP ${response.status}`);

    const payload = await response.json();
    if (!payload?.success || !payload?.data) {
      throw new Error(payload?.error || "TikTok service could not process this link");
    }

    const data = payload.data;
    const videoUrl = data.video?.hd_mp4 || data.video?.standard_mp4 || data.video?.wmplay;
    if (!videoUrl || !/^https:\/\//i.test(videoUrl)) {
      throw new Error("TikTok service did not return a usable MP4 URL");
    }

    const title = String(data.title || "").trim();
    const username = String(data.author?.username || "").replace(/^@/, "").trim();
    const caption = buildCaption(title);

    await env.DB.prepare(
      "UPDATE videos SET video_id = ?, author_username = ?, author_name = ?, video_file_url = ?, caption = ?, status = 'ready', error_message = NULL WHERE id = ?"
    ).bind(
      data.id ? String(data.id) : null,
      username || null,
      data.author?.nickname ? String(data.author.nickname) : null,
      videoUrl,
      caption,
      item.id
    ).run();

    if (env.TELEGRAM_ADMIN_CHAT_ID) {
      await sendTelegram(env, env.TELEGRAM_ADMIN_CHAT_ID,
        `✅ TikTok-видео обработано и поставлено в очередь публикации.\nАвтор: ${username ? "@" + username : "не указан"}`);
    }
  } catch (error) {
    console.error("TikTok processing failed:", item.id, error);
    await env.DB.prepare(
      "UPDATE videos SET status = 'failed', error_message = ? WHERE id = ?"
    ).bind(String(error.message || error).slice(0, 500), item.id).run();

    if (env.TELEGRAM_ADMIN_CHAT_ID) {
      await sendTelegram(env, env.TELEGRAM_ADMIN_CHAT_ID,
        `⚠️ Не удалось обработать TikTok-ссылку. Пришли её ещё раз позже. Причина: ${String(error.message || error).slice(0, 250)}`);
    }
  }
}

function buildCaption(title) {
  // Keep the creator's original TikTok text and hashtags; author and source
  // link are appended separately when the video is published to Telegram.
  return String(title || "").trim().slice(0, 900);
}

async function assignPublicationSlots(env) {
  const now = new Date();
  const candidates = await env.DB.prepare(
    "SELECT id FROM videos WHERE status = 'ready' AND video_file_url IS NOT NULL AND video_file_url != '' AND id NOT IN (SELECT video_id FROM publication_slots)"
  ).all();

  for (const video of candidates.results || []) {
    const slot = await findNextFreeSlot(env, now);
    if (!slot) return;

    const inserted = await env.DB.prepare(
      "INSERT OR IGNORE INTO publication_slots (video_id, scheduled_at, status) VALUES (?, ?, 'scheduled')"
    ).bind(video.id, slot).run();

    if (inserted.meta?.changes) {
      await env.DB.prepare("UPDATE videos SET status = 'scheduled' WHERE id = ?").bind(video.id).run();
    }
  }
}

async function findNextFreeSlot(env, fromDate) {
  const occupiedResult = await env.DB.prepare(
    "SELECT scheduled_at FROM publication_slots WHERE status IN ('scheduled', 'publishing', 'published')"
  ).all();
  const occupied = new Set((occupiedResult.results || []).map(row => row.scheduled_at));

  for (let day = 0; day < 14; day++) {
    const date = new Date(fromDate.getTime() + day * 86400000);
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit"
    }).formatToParts(date);
    const part = Object.fromEntries(parts.map(item => [item.type, item.value]));
    const y = Number(part.year), m = Number(part.month), d = Number(part.day);

    for (const [hour, minute] of DAILY_TIMES) {
      const slotDate = new Date(Date.UTC(y, m - 1, d, hour - 5, minute));
      if (slotDate <= fromDate) continue;
      const iso = slotDate.toISOString();
      if (!occupied.has(iso)) return iso;
    }
  }
  return null;
}

async function publishDueVideos(env) {
  const due = await env.DB.prepare(
    "SELECT publication_slots.id AS slot_id, publication_slots.video_id, videos.video_file_url, videos.caption, videos.author_username, videos.tiktok_url FROM publication_slots JOIN videos ON videos.id = publication_slots.video_id WHERE publication_slots.status = 'scheduled' AND publication_slots.scheduled_at <= ? ORDER BY publication_slots.scheduled_at LIMIT 3"
  ).bind(new Date().toISOString()).all();

  for (const item of due.results || []) {
    try {
      await env.DB.prepare("UPDATE publication_slots SET status = 'publishing' WHERE id = ? AND status = 'scheduled'").bind(item.slot_id).run();
      const captionParts = [];
      if (item.caption) captionParts.push(item.caption);
      if (item.author_username) captionParts.push(`Автор: @${item.author_username}`);
      if (item.tiktok_url) captionParts.push(`Оригинал: ${item.tiktok_url}`);
      const caption = captionParts.join("\n\n").slice(0, 1024);

      // Refresh the temporary CDN URL immediately before publication.
      // Downloader links can expire while a video waits in the schedule.
      const freshVideoUrl = await resolveTikTokVideo(item.tiktok_url);
      await env.DB.prepare("UPDATE videos SET video_file_url = ? WHERE id = ?")
        .bind(freshVideoUrl, item.video_id).run();

      const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendVideo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: env.TELEGRAM_CHANNEL, video: freshVideoUrl, caption })
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.description || "Telegram sendVideo failed");

      await env.DB.batch([
        env.DB.prepare("UPDATE publication_slots SET status = 'published', telegram_message_id = ? WHERE id = ?")
          .bind(String(result.result.message_id), item.slot_id),
        env.DB.prepare("UPDATE videos SET status = 'published', published_at = CURRENT_TIMESTAMP WHERE id = ?")
          .bind(item.video_id)
      ]);
    } catch (error) {
      console.error("Video publishing failed:", item.video_id, error);
      await env.DB.batch([
        env.DB.prepare("UPDATE publication_slots SET status = 'failed' WHERE id = ?").bind(item.slot_id),
        env.DB.prepare("UPDATE videos SET status = 'failed', error_message = ? WHERE id = ?")
          .bind(String(error.message || error).slice(0, 500), item.video_id)
      ]);
    }
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
