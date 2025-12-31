// === index.js（完整覆蓋版｜Render 穩定版｜常駐語音｜Gemini TTS｜防 IP discovery 崩潰）===
// ✅ 本版解決：
// 1) Render 偶發 "No open HTTP ports detected" → 加一個超小 HTTP server (health)
// 2) Voice UDP / IP discovery 不穩 → 偵測錯誤直接 destroy + 退避重連（不會卡半死）
// 3) 連線互斥：避免 message 觸發重複 join
// 4) Gemini TTS 偶爾回 parts=0 (finishReason OTHER) → 自動重試 + 文字修正提示 + 最後降級到「直接略過」不讓整體卡死
// 5) Opus encoder 支援 opusscript（推薦）/ @discordjs/opus / node-opus
// 6) 全面 error guard，避免 Render crash loop

import "dotenv/config";
import http from "http";
import { Client, GatewayIntentBits, Partials } from "discord.js";
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  entersState,
  VoiceConnectionStatus,
  AudioPlayerStatus,
  StreamType,
  getVoiceConnection,
} from "@discordjs/voice";
import fetch from "node-fetch";
import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/* =========================
   HTTP Health Server (Render friendly)
========================= */
const PORT = process.env.PORT || 10000;
http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("OK");
  })
  .listen(PORT, () => console.log("🌐 HTTP server listening on", PORT));

/* =========================
   ENV
========================= */
const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const TEXT_CHANNEL_ID = process.env.TEXT_CHANNEL_ID;
const VOICE_CHANNEL_ID = process.env.VOICE_CHANNEL_ID;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_TTS_MODEL = process.env.GEMINI_TTS_MODEL || "gemini-2.5-flash-preview-tts";
const GEMINI_VOICE_NAME = process.env.GEMINI_VOICE_NAME || "Kore";

// 之後要加的功能先預留
const COOLDOWN_MS = Number(process.env.COOLDOWN_MS || 0); // 例如 3000
const LONG_TEXT_THRESHOLD = Number(process.env.LONG_TEXT_THRESHOLD || 0); // 例如 120

function hasOpusEncoder() {
  try {
    require("opusscript");
    return "opusscript";
  } catch {}
  try {
    require("@discordjs/opus");
    return "@discordjs/opus";
  } catch {}
  try {
    require("node-opus");
    return "node-opus";
  } catch {}
  return null;
}
const opusImpl = hasOpusEncoder();

console.log("BOOT env check:", {
  hasToken: !!TOKEN,
  guild: GUILD_ID || null,
  text: TEXT_CHANNEL_ID || null,
  voice: VOICE_CHANNEL_ID || null,
  hasGeminiKey: !!GEMINI_API_KEY,
  geminiTtsModel: GEMINI_TTS_MODEL,
  geminiVoice: GEMINI_VOICE_NAME,
  ffmpeg: ffmpegPath ? "ok" : "missing",
  opus: opusImpl || "missing",
});

const missing = [];
if (!TOKEN) missing.push("DISCORD_TOKEN");
if (!GUILD_ID) missing.push("GUILD_ID");
if (!TEXT_CHANNEL_ID) missing.push("TEXT_CHANNEL_ID");
if (!VOICE_CHANNEL_ID) missing.push("VOICE_CHANNEL_ID");
if (!GEMINI_API_KEY) missing.push("GEMINI_API_KEY");
if (!ffmpegPath) missing.push("ffmpeg-static");
if (!opusImpl) missing.push("opus encoder (install opusscript recommended)");
if (missing.length) {
  console.error("❌ Missing ENV / dependency:", missing.join(", "));
  process.exit(1);
}

/* =========================
   Discord Client
========================= */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.Channel],
});

/* =========================
   Voice State
========================= */
let voiceConnection = null;
let connectLock = null; // 互斥：同一時間只允許一次 connect loop
let lastVoiceErrorAt = 0;

let player = null;
const queue = [];
let speaking = false;

const lastSpeak = new Map(); // userId -> ts (cooldown)

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function getOrCreatePlayer(conn) {
  if (!player) {
    player = createAudioPlayer();
    player.on("error", (err) => console.error("🔴 AudioPlayer error:", err?.message || err));
    player.on(AudioPlayerStatus.Playing, () => console.log("▶️ playing"));
    player.on(AudioPlayerStatus.Idle, () => console.log("⏹️ idle"));
  }
  try {
    conn.subscribe(player);
  } catch (e) {
    console.error("🔴 subscribe error:", e?.message || e);
  }
  return player;
}

function destroyVoice(reason = "destroy") {
  try {
    if (voiceConnection) {
      console.warn("🧨 destroy voice connection:", reason);
      voiceConnection.destroy();
    }
  } catch {}
  voiceConnection = null;
}

function shouldDestroyOnErrorMessage(msg) {
  const s = String(msg || "");
  return (
    s.includes("Cannot perform IP discovery") ||
    s.includes("socket closed") ||
    s.includes("The operation was aborted") ||
    s.includes("VOICE_CONNECTION") // 泛用
  );
}

async function connectVoiceOnce(guild) {
  const existing = getVoiceConnection(guild.id);
  if (existing && existing.state.status !== VoiceConnectionStatus.Destroyed) {
    voiceConnection = existing;
    return existing;
  }

  const voiceChannel = await guild.channels.fetch(VOICE_CHANNEL_ID);
  if (!voiceChannel) throw new Error(`Voice channel not found: ${VOICE_CHANNEL_ID}`);
  if (!voiceChannel.isVoiceBased()) throw new Error(`Target is not voice channel: ${VOICE_CHANNEL_ID}`);

  const conn = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    // ✅ Render/雲端常見更穩：自我靜音（不影響說話）
    selfDeaf: true,
    selfMute: false,
  });

  conn.on("error", (err) => {
    const msg = err?.message || String(err);
    console.error("🔴 VoiceConnection error:", msg);
    lastVoiceErrorAt = Date.now();
    // ✅ IP discovery 相關：立刻 destroy 讓 loop 重建
    if (shouldDestroyOnErrorMessage(msg)) destroyVoice("ip-discovery/error");
  });

  conn.on(VoiceConnectionStatus.Disconnected, () => {
    console.warn("🟠 Voice disconnected (will reconnect).");
    destroyVoice("disconnected");
  });

  await entersState(conn, VoiceConnectionStatus.Ready, 35_000);
  voiceConnection = conn;
  getOrCreatePlayer(conn);
  console.log("🎧 Voice ready (stable resident).");
  return conn;
}

// ✅ 常駐重連：互斥 + 無限重試 + 退避
async function ensureResidentVoice(guild) {
  if (voiceConnection) return voiceConnection;
  if (connectLock) return connectLock;

  connectLock = (async () => {
    let attempt = 0;
    while (!voiceConnection) {
      attempt += 1;
      try {
        console.log(`🔌 voice connect attempt ${attempt}...`);
        const conn = await connectVoiceOnce(guild);
        return conn;
      } catch (e) {
        const msg = e?.message || String(e);
        console.error("🔴 ensureResidentVoice failed:", msg);
        destroyVoice("connect-failed");

        // 退避：1s,2s,4s,8s,15s...
        const backoff = Math.min(15000, 1000 * Math.pow(2, Math.min(4, attempt - 1)));
        await sleep(backoff);
      }
    }
    return voiceConnection;
  })();

  try {
    return await connectLock;
  } finally {
    connectLock = null;
  }
}

/* =========================
   Gemini TTS (retry + compat parser)
========================= */
async function geminiGenerateTtsAudioBase64(text) {
  const safe = String(text || "").trim().slice(0, 500);
  if (!safe) throw new Error("empty tts text");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    GEMINI_TTS_MODEL
  )}:generateContent`;

  const body = {
    contents: [{ parts: [{ text: safe }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: GEMINI_VOICE_NAME } },
      },
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
    body: JSON.stringify(body),
  });

  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = json?.error?.message || `Gemini TTS HTTP ${res.status}`;
    throw new Error(msg);
  }

  const cand0 = json?.candidates?.[0];
  const parts = cand0?.content?.parts || [];
  for (const p of parts) {
    const inline = p?.inlineData || p?.inline_data;
    const data = inline?.data;
    const mime = inline?.mimeType || inline?.mime_type;
    if (typeof data === "string" && data.length > 20) {
      return { b64: data, mime: mime || "audio/L16" };
    }
  }

  console.error("🔎 Gemini TTS response debug:", {
    candidates: Array.isArray(json?.candidates) ? json.candidates.length : 0,
    partCount: parts.length,
    finishReason: cand0?.finishReason || cand0?.finish_reason || null,
    hasContent: !!cand0?.content,
  });

  throw new Error("Gemini TTS: missing inlineData.data");
}

async function geminiTtsPcm24kMono(text) {
  // ✅ 自動重試 + 文字修正提示
  const tries = [
    text,
    `請用語音輸出以下內容，不要回覆文字或其他格式：${text}`,
  ];

  let lastErr = null;
  for (let i = 0; i < tries.length; i++) {
    try {
      console.log("🔊 TTS request:", { len: String(tries[i]).length, pass: i + 1 });
      const { b64 } = await geminiGenerateTtsAudioBase64(tries[i]);
      return Buffer.from(b64, "base64");
    } catch (e) {
      lastErr = e;
      // 短暫等一下再試
      await sleep(500);
    }
  }
  throw lastErr || new Error("Gemini TTS failed");
}

function pcm24kMonoToDiscordRawStream(pcmBuf) {
  const ff = spawn(ffmpegPath, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "s16le",
    "-ar",
    "24000",
    "-ac",
    "1",
    "-i",
    "pipe:0",
    "-f",
    "s16le",
    "-ar",
    "48000",
    "-ac",
    "2",
    "pipe:1",
  ]);

  ff.stdin.on("error", () => {});
  ff.stdin.end(pcmBuf);

  ff.on("error", (e) => console.error("🔴 ffmpeg spawn error:", e?.message || e));
  ff.stderr.on("data", (d) => console.error("🔴 ffmpeg:", String(d)));

  return ff.stdout;
}

/* =========================
   Speak Queue
========================= */
async function speak(guild, text) {
  queue.push({ guild, text });
  if (speaking) return;

  speaking = true;
  while (queue.length) {
    const item = queue.shift();
    const t = item?.text?.trim();
    if (!t) continue;

    try {
      const conn = await ensureResidentVoice(item.guild);
      if (!conn) {
        console.warn("🟠 No voice connection (skip speak).");
        continue;
      }

      const pcm = await geminiTtsPcm24kMono(t);
      const rawStream = pcm24kMonoToDiscordRawStream(pcm);

      const resource = createAudioResource(rawStream, { inputType: StreamType.Raw });
      const p = getOrCreatePlayer(conn);

      await new Promise((resolve, reject) => {
        const onIdle = () => {
          cleanup();
          console.log("✅ played");
          resolve();
        };
        const onError = (err) => {
          cleanup();
          reject(err);
        };
        const cleanup = () => {
          p.removeListener(AudioPlayerStatus.Idle, onIdle);
          p.removeListener("error", onError);
        };

        p.once(AudioPlayerStatus.Idle, onIdle);
        p.once("error", onError);
        p.play(resource);
      });
    } catch (e) {
      console.error("❌ speak error:", e?.message || e);

      // ✅ 如果 voice error 很新鮮（剛爆），就讓連線重建一次再繼續
      if (Date.now() - lastVoiceErrorAt < 10_000) {
        destroyVoice("recent-voice-error");
        await sleep(1200);
      }
    }
  }
  speaking = false;
}

/* =========================
   Boot
========================= */
client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log("📝 Waiting for messages in TEXT_CHANNEL_ID =", TEXT_CHANNEL_ID);

  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    await ensureResidentVoice(guild);

    // 心跳：每 20 秒確認一次，若被 destroy 就重建
    setInterval(async () => {
      try {
        const g = client.guilds.cache.get(GUILD_ID) || (await client.guilds.fetch(GUILD_ID));
        if (!voiceConnection) await ensureResidentVoice(g);
      } catch (e) {
        console.error("heartbeat ensure voice error:", e?.message || e);
      }
    }, 20_000);
  } catch (e) {
    console.error("ready() ensure voice failed:", e?.message || e);
  }
});

client.on("messageCreate", async (msg) => {
  try {
    if (!msg || msg.author?.bot) return;
    if (msg.channelId !== TEXT_CHANNEL_ID) return;
    if (!msg.guild || msg.guildId !== GUILD_ID) return;

    const text = (msg.content || "").trim();
    if (!text) return;

    // 冷卻（可選）
    if (COOLDOWN_MS > 0) {
      const now = Date.now();
      const last = lastSpeak.get(msg.author.id) || 0;
      if (now - last < COOLDOWN_MS) return;
      lastSpeak.set(msg.author.id, now);
    }

    // 長文先保底截斷（下一步再接摘要 LLM）
    let say = text;
    if (LONG_TEXT_THRESHOLD > 0 && say.length > LONG_TEXT_THRESHOLD) {
      say = say.slice(0, LONG_TEXT_THRESHOLD) + "…";
    }

    console.log(`🟦 ${msg.author.username}: ${text}`);
    await speak(msg.guild, say);
  } catch (e) {
    console.error("messageCreate handler error:", e?.message || e);
  }
});

process.on("unhandledRejection", (reason) => console.error("🔴 unhandledRejection:", reason));
process.on("uncaughtException", (err) => console.error("🔴 uncaughtException:", err));

client.login(TOKEN);
