import { joinVoiceChannel, entersState, VoiceConnectionStatus } from "@discordjs/voice";

let voiceConnection = null;
let joining = false;

async function ensureVoiceConnection(voiceChannel) {
  if (voiceConnection && voiceConnection.state.status !== VoiceConnectionStatus.Destroyed) {
    return voiceConnection;
  }
  if (joining) return null;
  joining = true;

  try {
    const conn = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });

    // ✅ 1) 接住 error，避免整個程序退出
    conn.on("error", (err) => {
      console.error("🔴 VoiceConnection error:", err);
    });

    // ✅ 2) 斷線時不要死，嘗試重連
    conn.on(VoiceConnectionStatus.Disconnected, async () => {
      console.warn("🟠 Voice disconnected, retrying...");
      try {
        await entersState(conn, VoiceConnectionStatus.Connecting, 5_000);
      } catch {
        try { conn.destroy(); } catch {}
        voiceConnection = null;
      }
    });

    // 等 ready（不要讓未 ready 狀態繼續播音）
    await entersState(conn, VoiceConnectionStatus.Ready, 15_000);

    voiceConnection = conn;
    return conn;
  } catch (e) {
    console.error("🔴 ensureVoiceConnection failed:", e);
    try { voiceConnection?.destroy(); } catch {}
    voiceConnection = null;
    return null;
  } finally {
    joining = false;
  }
}
