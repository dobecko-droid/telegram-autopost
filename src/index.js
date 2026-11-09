
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
  async fetch(request, env, ctx) {
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

    if (request.method === "POST" && url.pathname.startsWith("/runner/")) {
      if (!env.DB || !env.TELEGRAM_WEBHOOK_SECRET ||
          request.headers.get("Authorization") !== `Bearer ${env.TELEGRAM_WEBHOOK_SECRET}`) {
        return new Response("Unauthorized", { status: 401 });
      }
      if (url.pathname === "/runner/claim") {
        return await runnerClaim(env);
      }
      if (url.pathname === "/runner/complete") {
        return await runnerComplete(request, env);
      }
      return Response.json({ ok: false, error: "Not found" }, { status: 404 });
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
        // Start processing a newly submitted link immediately instead of waiting
        // for the next five-minute cron tick. The DB claim below prevents races.
        ctx.waitUntil((async () => {
          if (env.EXTERNAL_DOWNLOADER !== "true") await processQueuedVideos(env);
          await assignPublicationSlots(env);
        })().catch(error => console.error("Immediate video processing failed:", error)));
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
    "INSERT OR IGNORE INTO app_settings (key, value) VALUES ('timezone', 'Asia/Tashkent'), ('daily_limit', '3'), ('telegram_channel', '@zadrot1705')",
    `CREATE TABLE IF NOT EXISTS ai_sessions (
      chat_id TEXT PRIMARY KEY,
      previous_response_id TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`
  ];
  for (const sql of statements) await db.prepare(sql).run();
  await ensureColumn(db, "videos", "attempt_count", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn(db, "videos", "next_attempt_at", "TEXT");
  await ensureColumn(db, "videos", "last_attempt_at", "TEXT");
  await ensureColumn(db, "videos", "telegram_file_id", "TEXT");
  await ensureColumn(db, "publication_slots", "attempt_count", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn(db, "publication_slots", "next_attempt_at", "TEXT");
  await ensureColumn(db, "publication_slots", "last_attempt_at", "TEXT");
}

async function ensureColumn(db, table, column, definition) {
  const result = await db.prepare("PRAGMA table_info(" + table + ")").all();
  const exists = (result.results || []).some(item => item.name === column);
  if (!exists) await db.prepare("ALTER TABLE " + table + " ADD COLUMN " + column + " " + definition).run();
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

  if (text.startsWith("/resetai")) {
    await env.DB.prepare("DELETE FROM ai_sessions WHERE chat_id = ?").bind(String(message.chat.id)).run();
    await sendTelegram(env, message.chat.id, "🧠 Контекст разговора с ИИ очищен. Можем начать заново.");
    return;
  }

  const match = text.match(TIKTOK_URL_RE);
  if (!match) {
    if (!text.trim()) return;
    await handleAiMessage(message, env);
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
        "UPDATE videos SET status = 'queued', error_message = NULL, video_file_url = NULL, telegram_file_id = NULL, next_attempt_at = NULL WHERE id = ?"
      ).bind(existing.id).run();
      await sendTelegram(env, message.chat.id,
        "🔄 Предыдущая попытка завершилась ошибкой. Ссылку вернул в очередь, попробую снова.");
    } else {
      await sendTelegram(env, message.chat.id, "ℹ️ Эта ссылка уже добавлена. Текущий статус: " + (existing?.status || "неизвестен") + ".");
    }
  }
}

async function handleAiMessage(message, env) {
  if (!env.OPENAI_API_KEY) {
    await sendTelegram(env, message.chat.id,
      "ИИ-помощник пока не подключён: администратору нужно добавить секрет OPENAI_API_KEY в Cloudflare Worker. Токен Telegram для этого не подходит.");
    return;
  }

  const chatId = String(message.chat.id);
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS ai_sessions (
    chat_id TEXT PRIMARY KEY,
    previous_response_id TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`).run();
  const userText = String(message.text || message.caption || "").trim().slice(0, 6000);
  if (!userText) return;

  try {
    const session = await env.DB.prepare(
      "SELECT previous_response_id FROM ai_sessions WHERE chat_id = ?"
    ).bind(chatId).first();

    const payload = {
      model: env.OPENAI_MODEL || "gpt-5.4-mini",
      instructions: "Ты — полезный русскоязычный ИИ-помощник внутри Telegram-бота. Отвечай понятно, доброжелательно и по делу. Учитывай контекст предыдущих сообщений. Если не уверен — честно скажи. Не утверждай, что выполнил действия вне чата. Пользователь может писать по-русски или по-узбекски; отвечай на языке сообщения.",
      input: userText,
      max_output_tokens: 700,
      store: true
    };
    if (session?.previous_response_id) payload.previous_response_id = session.previous_response_id;

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.error) {
      console.error("OpenAI API error:", response.status, result.error || result);
      throw new Error(result.error?.message || `OpenAI API HTTP ${response.status}`);
    }

    const answer = String(result.output_text || (result.output || [])
      .flatMap(item => item.content || [])
      .filter(item => item.type === "output_text")
      .map(item => item.text || "")
      .join("\\n")).trim();

    if (!answer) throw new Error("ИИ вернул пустой ответ");
    if (result.id) {
      await env.DB.prepare(
        "INSERT INTO ai_sessions (chat_id, previous_response_id, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(chat_id) DO UPDATE SET previous_response_id = excluded.previous_response_id, updated_at = CURRENT_TIMESTAMP"
      ).bind(chatId, result.id).run();
    }

    // Telegram text messages are limited to 4096 characters.
    await sendTelegram(env, chatId, answer.slice(0, 3900));
  } catch (error) {
    console.error("AI assistant failed:", error);
    await sendTelegram(env, chatId,
      "Не получилось получить ответ от ИИ. Проверь, добавлен ли OPENAI_API_KEY и включена ли оплата API. Попробуй ещё раз чуть позже.");
  }
}

async function runnerClaim(env) {
  const nowIso = new Date().toISOString();
  const staleBefore = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  await env.DB.prepare(
    "UPDATE videos SET status = 'queued', next_attempt_at = ? WHERE status = 'processing' AND last_attempt_at < ?"
  ).bind(nowIso, staleBefore).run();

  const item = await env.DB.prepare(
    "SELECT id, tiktok_url, source_chat_id, attempt_count FROM videos WHERE status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY submitted_at, id LIMIT 1"
  ).bind(nowIso).first();
  if (!item) return Response.json({ ok: true, item: null });

  const claim = await env.DB.prepare(
    "UPDATE videos SET status = 'processing', attempt_count = attempt_count + 1, last_attempt_at = ?, error_message = NULL WHERE id = ? AND status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)"
  ).bind(nowIso, item.id, nowIso).run();
  if (!claim.meta?.changes) return Response.json({ ok: true, item: null });

  return Response.json({
    ok: true,
    item: { id: item.id, url: item.tiktok_url, source_chat_id: item.source_chat_id }
  });
}

async function runnerComplete(request, env) {
  await ensureColumn(env.DB, "videos", "telegram_file_id", "TEXT");
  let body;
  try { body = await request.json(); }
  catch { return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400 }); }

  const id = Number(body?.id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return Response.json({ ok: false, error: "Valid id is required" }, { status: 400 });
  }

  const current = await env.DB.prepare(
    "SELECT status, attempt_count, source_chat_id FROM videos WHERE id = ?"
  ).bind(id).first();
  if (!current || current.status !== "processing") {
    return Response.json({ ok: false, error: "Job is not currently processing" }, { status: 409 });
  }

  if (body.ok === true) {
    const fileId = String(body.telegram_file_id || "");
    if (!fileId) return Response.json({ ok: false, error: "telegram_file_id is required" }, { status: 400 });
    const caption = String(body.caption || "").trim().slice(0, 900);
    const username = String(body.author_username || "").replace(/^@/, "").trim().slice(0, 100);
    const authorName = String(body.author_name || "").trim().slice(0, 200);
    await env.DB.prepare(
      "UPDATE videos SET video_id = ?, author_username = ?, author_name = ?, telegram_file_id = ?, video_file_url = NULL, caption = ?, status = 'ready', error_message = NULL, next_attempt_at = NULL WHERE id = ? AND status = 'processing'"
    ).bind(
      body.video_id ? String(body.video_id).slice(0, 100) : null,
      username || null, authorName || null, fileId, caption, id
    ).run();
    await assignPublicationSlots(env);
    return Response.json({ ok: true, status: "ready" });
  }

  const message = String(body.error || "GitHub runner failed").slice(0, 500);
  const count = Number(current.attempt_count || 1);
  const terminal = count >= 5;
  const delayMs = Math.min(6 * 60 * 60 * 1000, 5 * 60 * 1000 * (2 ** Math.max(0, count - 1)));
  const retryAt = new Date(Date.now() + delayMs).toISOString();
  await env.DB.prepare(
    "UPDATE videos SET status = ?, next_attempt_at = ?, error_message = ? WHERE id = ? AND status = 'processing'"
  ).bind(terminal ? "failed" : "queued", terminal ? null : retryAt, message, id).run();
  return Response.json({ ok: true, status: terminal ? "failed" : "queued", retry_at: terminal ? null : retryAt });
}

async function runSchedule(env) {
  if (!env.DB || !env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHANNEL) {
    console.error("Scheduler is missing DB, TELEGRAM_BOT_TOKEN, or TELEGRAM_CHANNEL");
    return;
  }

  if (env.EXTERNAL_DOWNLOADER !== "true") await processQueuedVideos(env);
  await assignPublicationSlots(env);
  await publishDueVideos(env);
}


async function fetchTikTokData(tiktokUrl) {
  const providers = [
    {
      name: "DrummerDuck",
      url: () => {
        const apiUrl = new URL("https://download-tktk-video.drummerduck.com/api/extract");
        apiUrl.searchParams.set("url", tiktokUrl);
        return apiUrl.toString();
      },
      parse: payload => {
        const media = (payload?.data?.media || []).find(item => item?.type === "video") || payload?.data?.media?.[0];
        const variants = media?.variants || [];
        const best = variants.find(item => item?.url && /mp4/i.test(item?.container || "mp4")) || variants.find(item => item?.url);
        return {
          videoUrl: best?.url || "",
          title: payload?.data?.text || "",
          videoId: "",
          username: payload?.data?.author?.handle || "",
          authorName: payload?.data?.author?.name || ""
        };
      },
      success: payload => payload?.ok === true && !!payload?.data?.media?.length
    },
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
      url: () => {
        const apiUrl = new URL("https://www.tikwm.com/api/");
        apiUrl.searchParams.set("url", tiktokUrl);
        apiUrl.searchParams.set("hd", "1");
        return apiUrl.toString();
      },
      headers: {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
        "referer": "https://www.tikwm.com/"
      },
      parse: payload => {
        const media = payload?.data?.hdplay || payload?.data?.play;
        return {
          videoUrl: media ? (media.startsWith("http") ? media : media.startsWith("//") ? "https:" + media : "https://www.tikwm.com" + (media.startsWith("/") ? "" : "/") + media) : "",
          title: payload?.data?.title || "",
          videoId: payload?.data?.id || "",
          username: payload?.data?.author?.unique_id || "",
          authorName: payload?.data?.author?.nickname || ""
        };
      },
      success: payload => (payload?.code === 0 || payload?.code === "0") && !!payload?.data
    }
  ];

  // Try providers sequentially. Starting every free API at once wastes
  // daily quotas even when an early provider succeeds; sequential fallback
  // contacts the next service only when the previous one actually fails.
  const errors = [];
  for (const provider of providers) {
    try {
      const response = await fetch(provider.url(), {
        method: provider.method || "GET",
        headers: { "accept": "application/json", ...(provider.headers || {}) },
        body: provider.body ? provider.body().toString() : undefined,
        signal: AbortSignal.timeout(15000)
      });
      if (!response.ok) {
        const responseBody = await response.text().catch(() => "");
        throw new Error(`HTTP ${response.status}${responseBody ? ": " + responseBody.slice(0, 180) : ""}`);
      }
      const payload = await response.json();
      if (!provider.success(payload)) {
        const detail = payload?.msg || payload?.message || payload?.error || JSON.stringify(payload).slice(0, 180);
        throw new Error(detail || "unexpected response format");
      }
      const data = provider.parse(payload);
      if (!data.videoUrl || !/^https:\/\//i.test(data.videoUrl)) {
        throw new Error("provider did not return a usable HTTPS video URL");
      }
      console.info("TikTok download provider succeeded:", provider.name);
      return data;
    } catch (error) {
      const message = `${provider.name}: ${String(error.message || error)}`;
      errors.push(message);
      console.error("TikTok provider failed:", message);
    }
  }

  throw new Error(errors.join("; ").slice(0, 450) || "All TikTok download providers failed");
}

async function resolveTikTokVideo(tiktokUrl) {
  const data = await fetchTikTokData(tiktokUrl);
  return data.videoUrl;
}

async function processQueuedVideos(env) {
  const now = new Date();
  const nowIso = now.toISOString();
  const staleBefore = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
  await env.DB.prepare("UPDATE videos SET status = 'queued', next_attempt_at = ? WHERE status = 'processing' AND last_attempt_at < ?").bind(nowIso, staleBefore).run();
  const item = await env.DB.prepare(
    "SELECT id, tiktok_url FROM videos WHERE status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY submitted_at, id LIMIT 1"
  ).bind(nowIso).first();
  if (!item) return;

  const claim = await env.DB.prepare(
    "UPDATE videos SET status = 'processing', attempt_count = attempt_count + 1, last_attempt_at = ?, error_message = NULL WHERE id = ? AND status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)"
  ).bind(nowIso, item.id, nowIso).run();
  if (!claim.meta?.changes) return;

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
    const attempts = await env.DB.prepare("SELECT attempt_count FROM videos WHERE id = ?").bind(item.id).first();
    const count = Number(attempts?.attempt_count || 1);
    const terminal = count >= 5;
    const delayMs = Math.min(6 * 60 * 60 * 1000, 5 * 60 * 1000 * (2 ** Math.max(0, count - 1)));
    const retryAt = new Date(Date.now() + delayMs).toISOString();
    await env.DB.prepare("UPDATE videos SET status = ?, next_attempt_at = ?, error_message = ? WHERE id = ?").bind(terminal ? "failed" : "queued", terminal ? null : retryAt, String(error.message || error).slice(0, 500), item.id).run();

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
  await ensureColumn(env.DB, "videos", "telegram_file_id", "TEXT");
  const now = new Date();
  const candidates = await env.DB.prepare(
    "SELECT id FROM videos WHERE status = 'ready' AND ((video_file_url IS NOT NULL AND video_file_url != '') OR (telegram_file_id IS NOT NULL AND telegram_file_id != '')) AND id NOT IN (SELECT video_id FROM publication_slots)"
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
  await ensureColumn(env.DB, "videos", "telegram_file_id", "TEXT");
  const nowIso = new Date().toISOString();
  const staleBefore = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  // Recover jobs left in "publishing" after a Worker interruption.
  await env.DB.prepare("UPDATE publication_slots SET status = 'scheduled', next_attempt_at = ? WHERE status = 'publishing' AND last_attempt_at < ?")
    .bind(nowIso, staleBefore).run();

  const due = await env.DB.prepare(
    "SELECT publication_slots.id AS slot_id, publication_slots.video_id, videos.video_file_url, videos.telegram_file_id, videos.caption, videos.author_username, videos.tiktok_url FROM publication_slots JOIN videos ON videos.id = publication_slots.video_id WHERE publication_slots.status = 'scheduled' AND publication_slots.scheduled_at <= ? AND (publication_slots.next_attempt_at IS NULL OR publication_slots.next_attempt_at <= ?) ORDER BY publication_slots.scheduled_at LIMIT 3"
  ).bind(nowIso, nowIso).all();

  for (const item of due.results || []) {
    try {
      const claim = await env.DB.prepare("UPDATE publication_slots SET status = 'publishing', attempt_count = attempt_count + 1, last_attempt_at = ? WHERE id = ? AND status = 'scheduled' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)")
        .bind(nowIso, item.slot_id, nowIso).run();
      if (!claim.meta?.changes) continue;
      const captionParts = [];
      if (item.caption) captionParts.push(item.caption);
      if (item.author_username) captionParts.push(`𝘼𝙪𝙩𝙝𝙤𝙧: @${item.author_username}`);
      if (item.tiktok_url) captionParts.push(`Оригинал: ${item.tiktok_url}`);
      const caption = captionParts.join("\n\n").slice(0, 1024);

      // Prefer refreshing a possibly expired CDN URL, but never let a
      // temporary downloader/API outage discard a URL that was already saved.
      let video = item.telegram_file_id || item.video_file_url;
      if (!item.telegram_file_id) {
        try {
          const refreshedUrl = await resolveTikTokVideo(item.tiktok_url);
          if (refreshedUrl && /^https:\/\//i.test(refreshedUrl)) {
            video = refreshedUrl;
            await env.DB.prepare("UPDATE videos SET video_file_url = ? WHERE id = ?")
              .bind(video, item.video_id).run();
          }
        } catch (refreshError) {
          console.warn("TikTok URL refresh failed; trying saved video URL:", refreshError);
        }
      }
      if (!video) throw new Error("No Telegram file_id or video URL is stored");

      const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendVideo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: env.TELEGRAM_CHANNEL, video, caption })
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
      const slotAttempt = await env.DB.prepare("SELECT attempt_count FROM publication_slots WHERE id = ?").bind(item.slot_id).first();
      const count = Number(slotAttempt?.attempt_count || 1);
      const terminal = count >= 5;
      const delayMs = Math.min(6 * 60 * 60 * 1000, 5 * 60 * 1000 * (2 ** Math.max(0, count - 1)));
      const retryAt = new Date(Date.now() + delayMs).toISOString();
      await env.DB.batch([
        env.DB.prepare("UPDATE publication_slots SET status = ?, next_attempt_at = ? WHERE id = ?")
          .bind(terminal ? "failed" : "scheduled", terminal ? null : retryAt, item.slot_id),
        env.DB.prepare("UPDATE videos SET status = ?, error_message = ? WHERE id = ?")
          .bind(terminal ? "failed" : "scheduled", String(error.message || error).slice(0, 500), item.video_id)
      ]);
      if (!terminal && env.TELEGRAM_ADMIN_CHAT_ID) {
        await sendTelegram(env, env.TELEGRAM_ADMIN_CHAT_ID,
          `🔁 Публикация не прошла. Повторю автоматически через несколько минут. Попытка ${count}/5. Причина: ${String(error.message || error).slice(0, 180)}`);
      }
    }
  }
}

async function sendTelegram(env, chatId, text) {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text })
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.ok) {
    throw new Error(`Telegram sendMessage failed: ${response.status} ${result?.description || "invalid Telegram response"}`);
  }
}
