import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, unlink } from "node:fs/promises";

const exec = promisify(execFile);
const WORKER_URL = process.env.WORKER_URL;
const RUNNER_SECRET = String(process.env.RUNNER_SECRET || "").trim();
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

if (!WORKER_URL || !RUNNER_SECRET || !TELEGRAM_BOT_TOKEN) {
  throw new Error("Missing WORKER_URL, RUNNER_SECRET or TELEGRAM_BOT_TOKEN");
}

async function worker(path, body) {
  const response = await fetch(new URL(path, WORKER_URL), {
    method: "POST",
    headers: {
      "authorization": `Bearer ${RUNNER_SECRET}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const responseText = await response.text();
  let data = {};
  try { data = responseText ? JSON.parse(responseText) : {}; } catch {}
  if (!response.ok || !data.ok) {
    let detail = String(data.error || responseText || "empty response");
    for (const secret of [RUNNER_SECRET, TELEGRAM_BOT_TOKEN]) {
      if (secret) detail = detail.split(secret).join("[redacted]");
    }
    detail = detail.replace(/[\\r\\n]+/g, " ").slice(0, 500);
    throw new Error(`Worker ${path} failed: HTTP ${response.status}; ${detail}`);
  }
  return data;
}

async function telegram(method, form) {
  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    body: form
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    throw new Error(data.description || `Telegram ${method} failed: HTTP ${response.status}`);
  }
  return data.result;
}

function getUsername(info) {
  let value = info.uploader_id || "";
  if (!value && info.uploader_url) {
    value = info.uploader_url.match(/@([^/?]+)/)?.[1] || "";
  }
  return String(value).replace(/^@/, "").trim();
}

async function run() {
  const claim = await worker("/runner/claim", {});
  const item = claim.item;
  if (!item) {
    console.log("Queue is empty.");
    return;
  }

  let tempMessageId = null;
  let tempFileId = null;
  let localFile = null;

  try {
    console.log(`Processing video job ${item.id}`);
    const { stdout: metadataText } = await exec("yt-dlp", [
      "--no-warnings", "--no-playlist", "--dump-single-json", item.url
    ], { maxBuffer: 8 * 1024 * 1024, timeout: 120000 });
    const metadata = JSON.parse(metadataText);
    const username = getUsername(metadata);
    const caption = String(metadata.description || metadata.title || "").trim().slice(0, 900);

    const { stdout: pathOutput } = await exec("yt-dlp", [
      "--no-warnings",
      "--no-playlist",
      // TikTok normally provides a progressive MP4 containing both audio
      // and video. Select a single-file MP4 so this runner does not need
      // FFmpeg installation/merging (which previously consumed the whole job).
      "--format", "b[ext=mp4]",
      "--max-filesize", "49M",
      "--output", "video.%(ext)s",
      "--print", "after_move:filepath",
      item.url
    ], { maxBuffer: 2 * 1024 * 1024, timeout: 240000 });
    localFile = pathOutput.trim().split("\n").filter(Boolean).at(-1);
    if (!localFile) throw new Error("yt-dlp did not return the downloaded file path");

    const bytes = await readFile(localFile);
    if (bytes.length > 49 * 1024 * 1024) {
      throw new Error("Video is larger than the 49 MB Telegram upload safety limit");
    }
    if (!item.source_chat_id) {
      throw new Error("No source Telegram chat is stored for this video");
    }

    // Upload silently to the submitting private chat to obtain a permanent
    // Telegram file_id, then remove the temporary message. The channel post
    // itself is still published later by the scheduled Cloudflare Worker.
    const form = new FormData();
    form.set("chat_id", String(item.source_chat_id));
    form.set("disable_notification", "true");
    form.set("supports_streaming", "true");
    form.set("video", new Blob([bytes], { type: "video/mp4" }), "tiktok.mp4");
    const sent = await telegram("sendVideo", form);
    tempMessageId = sent.message_id;
    tempFileId = sent.video?.file_id;
    if (!tempFileId) throw new Error("Telegram accepted the upload but returned no video file_id");

    const cleanup = new FormData();
    cleanup.set("chat_id", String(item.source_chat_id));
    cleanup.set("message_id", String(tempMessageId));
    try {
      await telegram("deleteMessage", cleanup);
      tempMessageId = null;
    } catch (error) {
      console.warn("Could not remove temporary private-chat upload:", error.message);
    }

    await worker("/runner/complete", {
      id: item.id,
      ok: true,
      telegram_file_id: tempFileId,
      video_id: metadata.id || null,
      author_username: username,
      author_name: metadata.uploader || "",
      caption
    });
    console.log(`Video job ${item.id} stored in Telegram and scheduled.`);
  } catch (error) {
    if (tempMessageId) {
      const cleanup = new FormData();
      cleanup.set("chat_id", String(item.source_chat_id));
      cleanup.set("message_id", String(tempMessageId));
      await telegram("deleteMessage", cleanup).catch(() => {});
    }
    await worker("/runner/complete", {
      id: item.id,
      ok: false,
      error: String(error?.message || error).slice(0, 500)
    });
    throw error;
  } finally {
    if (localFile) await unlink(localFile).catch(() => {});
  }
}

await run();
