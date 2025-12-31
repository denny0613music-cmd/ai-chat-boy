// === index.js（完整覆蓋版｜文字→Gemini TTS→語音播放｜Render Worker 版）===
// 你已經跑通「收 Discord 文字→進語音→播音」，這版把 TTS 換成 Gemini 官方 TTS（更穩、可控）
// Gemini TTS 參考：Gemini API Speech generation (TTS) - generateContent + responseModalities=["AUDIO"]
// https://ai.google.dev/gemini-api/docs/speech-generation

import "dotenv/config";
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
import { Readable } from "node:stream";
import ffmpegPath from "ffmpeg-static";

/* =========================
   ENV
========================= */
const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const TEXT_CHANNEL_ID = process.env.TEXT_CHANNEL_ID;
const VOICE_CHANNEL_ID = process.env.VOICE_CHANNEL_ID;

// ✅ Gemini API Key（你之前的 AI bot 已經在用）
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// TTS model / voice
// 官方範例：gemini-2.5-flash-preview-tts + voiceName "Kore"
const GEMINI_TTS_MODEL = process.env.GEMINI_TTS_MODEL || "gemini-2.5-flash-preview-tts";
const GEMINI_VOICE_NAME = process.env.GEMINI_VOICE_NAME || "Kore";

// 啟動時先印出 env 檢查（Render 早退時最有用）
console.log("BOOT env check:", {
  hasToken: !!TOKEN,
  guild: GUILD_ID || null,
  text: TEXT_CHANNEL_ID || null,
  voice: VOICE_CHANNEL_ID || null,
  hasGeminiKey: !!GEMINI_API_KEY,
  geminiTtsModel: GEMINI_TTS_MODEL,
  geminiVoice: GEMINI_VOICE_NAME,
  ffmpeg: ffmpegPath ? "ok" : "missing",
});

// 缺 env 就明確印出並退出（避免靜默 early exit）
const missing = [];
if (!TOKEN) missing.push("DISCORD_TOKEN");
if (!GUILD_ID) missing.push("GUILD_ID");
if (!TEXT_CHANNEL_ID) missing.push("TEXT_CHANNEL_ID");
if (!VOICE_CHANNEL_ID) missing.push("VOICE_CHANNEL_ID");
if (!GEMINI_API_KEY) missing.push("GEMINI_API_KEY");
if (!ffmpegPath) missing.push("ffmpeg-static (dependency)");
if (missing.length) {
  console.error("❌ Missing ENV / dependency:", missing.join(", "));
  console.error("👉 Render 環境變數請補 GEMINI_API_KEY；本機請先 npm i ffmpeg-static");
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
let joining = false;
let player = null;

// 播放佇列避免多人連續訊息把播放器打爆
const queue = [];
let speaking = false;

function getOrCreatePlayer(conn) {
  if (!player) {
    player = createAudioPlayer();
    player.on("error", (err) => {
      console.error("🔴 AudioPlayer error:", err?.message || err);
    });
  }
  try {
    conn.subscribe(player);
  } catch (e) {
    console.error("🔴 subscribe error:", e?.message || e);
  }
  return player;
}

async function ensureVoiceConnection(guild) {
  const existing = getVoiceConnection(guild.id);
  if (existing && existing.state.status !== VoiceConnectionStatus.Destroyed) {
    voiceConnection = existing;
    return existing;
  }

  if (joining) return null;
  joining = true;

  try {
    const voiceChannel = await guild.channels.fetch(VOICE_CHANNEL_ID);
    if (!voiceChannel) {
      console.error("❌ Voice channel not found:", VOICE_CHANNEL_ID);
      return null;
    }
    if (!voiceChannel.isVoiceBased()) {
      console.error("❌ Target channel is not voice-based:", VOICE_CHANNEL_ID);
      return null;
    }

    const conn = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });

    // ✅ 接住 error：避免 Render 直接 exit
    conn.on("error", (err) => {
      console.error("🔴 VoiceConnection error:", err?.message || err);
    });

    // ✅ 斷線時嘗試恢復，不行就銷毀讓下次重建
    conn.on(VoiceConnectionStatus.Disconnected, async () => {
      console.warn("🟠 Voice disconnected, retrying...");
      try {
        await entersState(conn, VoiceConnectionStatus.Connecting, 5_000);
      } catch {
        try {
          conn.destroy();
        } catch {}
        voiceConnection = null;
      }
    });

    // 不讓未 ready 狀態直接播
    await entersState(conn, VoiceConnectionStatus.Ready, 15_000);

    voiceConnection = conn;
    getOrCreatePlayer(conn);
    console.log("🎧 Voice ready.");
    return conn;
  } catch (e) {
    console.error("🔴 ensureVoiceConnection failed:", e?.message || e);
    try {
      voiceConnection?.destroy();
    } catch {}
    voiceConnection = null;
    return null;
  } finally {
    joining = false;
  }
}

/* =========================
   Gemini TTS
   - 依官方 TTS Guide：generateContent + generationConfig.responseModalities=["AUDIO"]
   - 回傳 inlineData.data (base64) -> PCM (s16le 24k mono)
   - 我們用 ffmpeg 即時轉成 Discord 可吃的 RAW PCM：s16le 48k stereo
========================= */
async function geminiTtsPcm24kMono(text) {
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
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: GEMINI_VOICE_NAME },
        },
      },
    },
    model: GEMINI_TTS_MODEL,
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": GEMINI_API_KEY,
    },
    body: JSON.stringify(body),
  });

  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = json?.error?.message || `Gemini TTS HTTP ${res.status}`;
    throw new Error(msg);
  }

  const b64 = json?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  if (!b64) throw new Error("Gemini TTS: missing inlineData.data");
  return Buffer.from(b64, "base64"); // PCM s16le, 24000Hz, mono
}

function pcm24kMonoToDiscordRawStream(pcmBuf) {
  // Discord 的 StreamType.Raw 預設期待：s16le 48000Hz stereo
  // 用 ffmpeg 做 resample + upmix
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

  // 寫入 PCM buffer
  ff.stdin.on("error", () => {});
  ff.stdin.end(pcmBuf);

  // 若 ffmpeg 噴錯，別讓整個程序死
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
      const conn = await ensureVoiceConnection(item.guild);
      if (!conn) {
        console.warn("🟠 No voice connection (skip speak).");
        continue;
      }

      const pcm = await geminiTtsPcm24kMono(t);
      const rawStream = pcm24kMonoToDiscordRawStream(pcm);

      const resource = createAudioResource(rawStream, {
        inputType: StreamType.Raw,
      });

      const p = getOrCreatePlayer(conn);

      await new Promise((resolve, reject) => {
        const onIdle = () => {
          cleanup();
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
  // 不在啟動時 join voice：避免 Render UDP/IP discovery 不穩導致 crash loop
});

client.on("messageCreate", async (msg) => {
  try {
    if (!msg || msg.author?.bot) return;
    if (msg.channelId !== TEXT_CHANNEL_ID) return;
    if (!msg.guild || msg.guildId !== GUILD_ID) return;

    const text = (msg.content || "").trim();
    if (!text) return;

    console.log(`🟦 ${msg.author.username}: ${text}`);
    await speak(msg.guild, text);
  } catch (e) {
    console.error("messageCreate handler error:", e?.message || e);
  }
});

// 保底：接住未捕捉錯誤，避免 Render 直接退出
process.on("unhandledRejection", (reason) => {
  console.error("🔴 unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("🔴 uncaughtException:", err);
});

client.login(TOKEN);
