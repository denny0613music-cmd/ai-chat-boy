// === index.js（完整覆蓋版｜文字→TTS→語音播放｜Render Worker 版）===
// 目標：
// 1) 讀指定文字頻道訊息
// 2) 需要播音時才 join 指定語音頻道（避免啟動就撞 UDP / IP discovery）
// 3) VoiceConnection / Player errors 全部接住，避免 Render crash loop
// 4) 啟動時印出 env 是否齊全，快速定位 "Application exited early"

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

/* =========================
   ENV
========================= */
const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const TEXT_CHANNEL_ID = process.env.TEXT_CHANNEL_ID;
const VOICE_CHANNEL_ID = process.env.VOICE_CHANNEL_ID;

// 啟動時先印出 env 檢查（Render 早退時最有用）
console.log("BOOT env check:", {
  hasToken: !!TOKEN,
  guild: GUILD_ID || null,
  text: TEXT_CHANNEL_ID || null,
  voice: VOICE_CHANNEL_ID || null,
});

// 缺 env 就明確印出並退出（避免靜默 early exit）
const missing = [];
if (!TOKEN) missing.push("DISCORD_TOKEN");
if (!GUILD_ID) missing.push("GUILD_ID");
if (!TEXT_CHANNEL_ID) missing.push("TEXT_CHANNEL_ID");
if (!VOICE_CHANNEL_ID) missing.push("VOICE_CHANNEL_ID");
if (missing.length) {
  console.error("❌ Missing ENV:", missing.join(", "));
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

    conn.on("error", (err) => {
      console.error("🔴 VoiceConnection error:", err?.message || err);
    });

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
   TTS (Google Translate TTS - 免 key 跑通版)
========================= */
async function ttsToMp3Stream(text) {
  const safe = String(text || "").trim().slice(0, 180);
  if (!safe) throw new Error("empty tts text");

  const q = encodeURIComponent(safe);
  const url = `https://translate.google.com/translate_tts?ie=UTF-8&tl=zh-TW&client=tw-ob&q=${q}`;

  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  if (!res.ok) throw new Error(`TTS HTTP ${res.status}`);
  return res.body;
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

      const mp3Stream = await ttsToMp3Stream(t);
      const resource = createAudioResource(mp3Stream, {
        inputType: StreamType.Arbitrary,
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

process.on("unhandledRejection", (reason) => {
  console.error("🔴 unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("🔴 uncaughtException:", err);
});

client.login(TOKEN);
