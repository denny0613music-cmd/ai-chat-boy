import "dotenv/config";
import { Client, GatewayIntentBits, Partials } from "discord.js";
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  getVoiceConnection,
  StreamType,
} from "@discordjs/voice";
import fetch from "node-fetch";

const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const TEXT_CHANNEL_ID = process.env.TEXT_CHANNEL_ID;
const VOICE_CHANNEL_ID = process.env.VOICE_CHANNEL_ID;

if (!TOKEN || !GUILD_ID || !TEXT_CHANNEL_ID || !VOICE_CHANNEL_ID) {
  console.error("❌ .env 缺少 DISCORD_TOKEN / GUILD_ID / TEXT_CHANNEL_ID / VOICE_CHANNEL_ID");
  process.exit(1);
}

// 佇列避免多人同時說話把播放器打爆
const queue = [];
let speaking = false;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.Channel],
});

let player = null;

function ensureVoiceConnection(guild) {
  let conn = getVoiceConnection(guild.id);
  if (!conn) {
    conn = joinVoiceChannel({
      channelId: VOICE_CHANNEL_ID,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });
  }
  if (!player) {
    player = createAudioPlayer();
    conn.subscribe(player);
  }
  return conn;
}

// 先用免 Key 的 Google Translate TTS 跑通（之後可換正式 TTS）
async function ttsToMp3Stream(text) {
  const q = encodeURIComponent(text.slice(0, 180)); // 先限制長度避免爆
  const url = `https://translate.google.com/translate_tts?ie=UTF-8&tl=zh-TW&client=tw-ob&q=${q}`;

  const res = await fetch(url, {
    headers: {
      // 沒有 UA 有時會被擋
      "User-Agent": "Mozilla/5.0",
    },
  });
  if (!res.ok) throw new Error(`TTS HTTP ${res.status}`);
  return res.body; // node stream (mp3)
}

async function speak(guild, text) {
  queue.push({ guild, text });
  if (speaking) return;

  speaking = true;
  while (queue.length) {
    const { guild, text } = queue.shift();
    try {
      ensureVoiceConnection(guild);
      const mp3Stream = await ttsToMp3Stream(text);

      const resource = createAudioResource(mp3Stream, {
        inputType: StreamType.Arbitrary,
      });

      await new Promise((resolve, reject) => {
        player.play(resource);

        const onIdle = () => {
          cleanup();
          resolve();
        };
        const onError = (err) => {
          cleanup();
          reject(err);
        };
        const cleanup = () => {
          player.removeListener(AudioPlayerStatus.Idle, onIdle);
          player.removeListener("error", onError);
        };

        player.once(AudioPlayerStatus.Idle, onIdle);
        player.once("error", onError);
      });
    } catch (e) {
      console.error("❌ speak error:", e.message);
    }
  }
  speaking = false;
}

client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  const guild = await client.guilds.fetch(GUILD_ID);
  ensureVoiceConnection(guild);
  console.log("🎧 已連線語音頻道，等待文字訊息...");
});

client.on("messageCreate", async (msg) => {
  if (msg.author.bot) return;
  if (msg.channelId !== TEXT_CHANNEL_ID) return;

  const guild = msg.guild;
  if (!guild) return;

  // 最小可用版：先把訊息念出來（確認聲音鏈路OK）
  const text = msg.content.trim();
  if (!text) return;

  console.log(`🟦 ${msg.author.username}: ${text}`);
  await speak(guild, text);
});

client.login(TOKEN);
