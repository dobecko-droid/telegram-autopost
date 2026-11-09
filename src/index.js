
const SETUP_PAGE = `<!doctype html>
<html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Настройка Telegram</title>
<style>
body{font:16px system-ui;max-width:520px;margin:40px auto;padding:0 18px;background:#111;color:#eee}
input,button{box-sizing:border-box;width:100%;padding:14px;margin:10px 0;border-radius:9px;border:1px solid #555;font:inherit}
input{background:#222;color:#fff}button{background:#2684ff;color:white;border:0;font-weight:600}
#result{white-space:pre-wrap;overflow-wrap:anywhere}
</style>
<h2>Подключение Telegram-бота</h2>
<p>Вставь сюда значение <b>TELEGRAM_WEBHOOK_SECRET</b>, которое сохранено в Cloudflare. Токен бота сюда вводить не нужно.</p>
<form id="f"><input id="secret" type="password" autocomplete="off" placeholder="TELEGRAM_WEBHOOK_SECRET" required><button type="button" id="db">1. Подготовить базу данных</button><button type="submit">2. Подключить Telegram</button></form>
<p id="result"></p>
<script>
const secret=()=>document.getElementById('secret').value;
const out=document.getElementById('result');
async function post(path){const r=await fetch(path,{method:'POST',headers:{Authorization:'Bearer '+secret()}});
 const j=await r.json();if(!r.ok||!j.ok)throw new Error(j.error||'Ошибка настройки');return j;}
document.getElementById('db').addEventListener('click',async()=>{out.textContent='Создаю таблицы…';try{await post('/admin/init-db');out.textContent='Готово! База данных подготовлена.';}catch(e){out.textContent='Ошибка: '+e.message;}});
document.getElementById('f').addEventListener('submit',async e=>{e.preventDefault();out.textContent='Подключаю Telegram…';try{await post('/admin/setup-webhook');out.textContent='Готово! Telegram подключён.';}catch(e){out.textContent='Ошибка: '+e.message;}});
</script></html>`;

const TIKTOK_URL_RE = /https?:\/\/(?:www\.|vm\.|vt\.)?tiktok\.com\/[^\s]+/i;
const TIME_ZONE = "Asia/Tashkent";
const DAILY_TIMES = [[10, 0], [15, 0], [20, 0]];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true, service: "telegram-autopost" });
    }

    if (request.method === "GET" && url.pathname === "/setup") {
      return new Response(SETUP_PAGE, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }
      });
    }

    if (request.method === "POST" && url.pathname === "/admin/init-db") {
      if (!env.DB || !env.TELEGRAM_WEBHOOK_SECRET) {
        return Response.json({ ok: false, error: "D1 binding DB and TELEGRAM_WEBHOOK_SECRET are required" }, { status: 500 });
      }
      if (request.headers.get("Authorization") !== `Bearer ${env.TELEGRAM_WEBHOOK_SECRET}`) {
        return new Response("Unauthorized", { status: 401 });
      }
      try {
        await initializeDatabase(env.DB);
        return Response.json({ ok: true, description: "Database initialized" });
      } catch (error) {
        console.error("Database initialization failed:", error);
        return Response.json({ ok: false, error: String(error.message || error) }, { status: 500 });
      }
    }

    if (request.method === "POST" && url.pathname === "/admin/setup-webhook") {
      if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET) {
        return Response.json({ ok: false, error: "Set TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET first" }, { status: 500 });
      }
      if (request.headers.get("Authorization") !== `Bearer ${env.TELEGRAM_WEBHOOK_SECRET}`) {
        return new Response("Unauthorized", { status: 401 });
      }
      const webhookUrl = `${url.origin}/webhook`;
      const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: webhookUrl,
          secret_token: env.TELEGRAM_WEBHOOK_SECRET,
          allowed_updates: ["message"],
          drop_pending_updates: false
        })
      });
      const result = await response.json();
      if (!response.ok || !result.ok) {
        return Response.json({ ok: false, error: result.description || "Telegram setWebhook failed" }, { status: 502 });
      }
      return Response.json({ ok: true, webhook_url: webhookUrl, description: "Telegram webhook configured" });
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

async function initializeDatabase(db) {
  const statements = [
    `CREATE TABLE IF NOT EXISTS videos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tiktok_url TEXT NOT NULL UNIQUE,
      video_id TEXT UNIQUE,
      author_username TEXT,
      author_name TEXT,
      video_file_url TEXT,
      caption TEXT,
      popular_comment TEXT,
      status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'processing', 'ready', 'scheduled', 'published', 'failed')),
      submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      published_at TEXT,
      error_message TEXT,
      source_chat_id TEXT,
      source_message_id TEXT
    )`,
    "CREATE INDEX IF NOT EXISTS idx_videos_status_submitted ON videos(status, submitted_at)",
    `CREATE TABLE IF NOT EXISTS publication_slots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id INTEGER NOT NULL UNIQUE REFERENCES videos(id) ON DELETE CASCADE,
      scheduled_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'scheduled'
        CHECK (status IN ('scheduled', 'publishing', 'published', 'failed')),
      telegram_message_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    "CREATE INDEX IF NOT EXISTS idx_publication_slots_status_time ON publication_slots(status, scheduled_at)",
    `CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`,
    "INSERT OR IGNORE INTO app_settings (key, value) VALUES ('timezone', 'Asia/Tashkent'), ('daily_limit', '3'), ('telegram_channel', '@zadrot1705')"
  ];
  for (const sql of statements) await db.prepare(sql).run();
}

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

  if (text.startsWith("/status")) {
    const result = await env.DB.prepare(
      "SELECT videos.status, videos.error_message, videos.submitted_at, publication_slots.scheduled_at FROM videos LEFT JOIN publication_slots ON publication_slots.video_id = videos.id ORDER BY videos.id DESC LIMIT 5"
    ).all();
    const rows = result.results || [];
    const report = rows.length
      ? rows.map((row, index) => {
          const details = [
            `${index + 1}. Статус: ${row.status}`,
            row.scheduled_at ? `Публикация: ${row.scheduled_at} UTC` : "",
            row.error_message ? `Ошибка: ${row.error_message}` : ""
          ].filter(Boolean);
          return details.join("\n");
        }).join("\n\n")
      : "Пока нет сохранённых видео.";
    await sendTelegram(env, message.chat.id, `📊 Последние видео:\\n\\n${report}`);
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
      "✅ Ссылка принята и добавлена в очередь на обработку.");
  } else {
    const existing = await env.DB.prepare(
      "SELECT id, status FROM videos WHERE tiktok_url = ?"
    ).bind(tiktokUrl).first();
    if (existing?.status === "failed") {
      await env.DB.prepare("DELETE FROM publication_slots WHERE video_id = ?").bind(existing.id).run();
      await env.DB.prepare(
        "UPDATE videos SET status = 'queued', error_message = NULL, video_file_url = NULL WHERE id = ?"
      ).bind(existing.id).run();
      await sendTelegram(env, message.chat.id,
        "🔄 Предыдущая попытка завершилась ошибкой. Ссылку вернул в очередь, попробую снова.");
    } else {
      await sendTelegram(env, message.chat.id, "ℹ️ Эта ссылка уже добавлена. Текущий статус: " + (existing?.status || "неизвестен") + ".");
    }
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


async function fetchTikTokData(tiktokUrl) {
  const providers = [
    {
      name: "ClipX",
      url: () => {
        const apiUrl = new URL("https://clipx.zamdev.workers.dev/");
        apiUrl.searchParams.set("url", tiktokUrl);
        apiUrl.searchParams.set("quality", "best");
        apiUrl.searchParams.set("audio", "true");
        apiUrl.searchParams.set("cover", "false");
        apiUrl.searchParams.set("metadata", "false");
        return apiUrl.toString();
      },
      parse: payload => ({
        videoUrl: payload?.data?.video?.hd_mp4 || payload?.data?.video?.standard_mp4 || payload?.data?.video?.wmplay,
        title: payload?.data?.title || "",
        videoId: payload?.data?.id || "",
        username: payload?.data?.author?.username || "",
        authorName: payload?.data?.author?.nickname || ""
      }),
      success: payload => payload?.success === true && !!payload?.data
    },
    {
      name: "TikTok fallback",
      url: () => {
        const apiUrl = new URL("https://tdownv4.sl-bjs.workers.dev/");
        apiUrl.searchParams.set("down", tiktokUrl);
        return apiUrl.toString();
      },
      parse: payload => ({
        videoUrl: payload?.download_url,
        title: payload?.title || "",
        videoId: payload?.video_id || "",
        username: payload?.author?.username || "",
        authorName: payload?.author?.nickname || payload?.author?.username || ""
      }),
      success: payload => !!payload?.download_url
    },
    {
      name: "TikWM",
      url: () => "https://www.tikwm.com/api/",
      method: "POST",
      body: () => new URLSearchParams({ url: tiktokUrl, count: "12", cursor: "0", web: "1", hd: "1" }),
      headers: {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
        "referer": "https://www.tikwm.com/"
      },
      parse: payload => {
        const media = payload?.data?.hdplay || payload?.data?.play;
        return {
          videoUrl: media ? (media.startsWith("http") ? media : "https://www.tikwm.com" + (media.startsWith("/") ? "" : "/") + media) : "",
          title: payload?.data?.title || "",
          videoId: payload?.data?.id || "",
          username: payload?.data?.author?.unique_id || "",
          authorName: payload?.data?.author?.nickname || ""
        };
      },
      success: payload => (payload?.code === 0 || payload?.code === "0") && !!payload?.data
    }
  ];

  const errors = [];
  for (const provider of providers) {
    try {
      const response = await fetch(provider.url(), {
        method: provider.method || "GET",
        headers: { "accept": "application/json", ...(provider.method === "POST" ? { "content-type": "application/x-www-form-urlencoded", ...(provider.headers || {}) } : {}) },
        body: provider.body ? provider.body().toString() : undefined,
        signal: AbortSignal.timeout(60000)
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      if (!provider.success(payload)) {
        const detail = payload?.msg || payload?.message || payload?.error || JSON.stringify(payload).slice(0, 180);
        throw new Error(detail || "unexpected response format");
      }
      const data = provider.parse(payload);
      if (!data.videoUrl || !/^https:\/\//i.test(data.videoUrl)) {
        throw new Error("provider did not return a usable HTTPS video URL");
      }
      return data;
    } catch (error) {
      errors.push(`${provider.name}: ${String(error.message || error)}`);
      console.error("TikTok provider failed:", provider.name, error);
    }
  }
  throw new Error(errors.join("; ").slice(0, 450) || "All TikTok download providers failed");
}

async function resolveTikTokVideo(tiktokUrl) {
  const data = await fetchTikTokData(tiktokUrl);
  return data.videoUrl;
}

async function processQueuedVideos(env) {
  const item = await env.DB.prepare(
    "SELECT id, tiktok_url FROM videos WHERE status = 'queued' ORDER BY submitted_at, id LIMIT 1"
  ).first();
  if (!item) return;

  await env.DB.prepare(
    "UPDATE videos SET status = 'processing', error_message = NULL WHERE id = ? AND status = 'queued'"
  ).bind(item.id).run();

  try {
    const data = await fetchTikTokData(item.tiktok_url);
    const caption = buildCaption(data.title);

    await env.DB.prepare(
      "UPDATE videos SET video_id = ?, author_username = ?, author_name = ?, video_file_url = ?, caption = ?, status = 'ready', error_message = NULL WHERE id = ?"
    ).bind(
      data.videoId ? String(data.videoId) : null,
      data.username ? String(data.username).replace(/^@/, "") : null,
      data.authorName ? String(data.authorName) : null,
      data.videoUrl,
      caption,
      item.id
    ).run();

    if (env.TELEGRAM_ADMIN_CHAT_ID) {
      await sendTelegram(env, env.TELEGRAM_ADMIN_CHAT_ID,
        `✅ TikTok-видео обработано и поставлено в очередь публикации.\nАвтор: ${data.username ? "@" + data.username : "не указан"}`);
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
