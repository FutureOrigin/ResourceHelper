/**
 * 音轨配对（I3：依赖闭合）
 *
 * 问题（AUDIT A3）：音画分离的源里，视频轨与音轨是两条独立资源，
 * 谁也不认识谁，于是"1080P"下出来的是无声 MP4。
 *
 * 这里按"容器族 + 语言 + 码率"给每条视频轨挑一条最合适的音轨。
 * 纯函数，不依赖网络与存储。
 */

const CONTAINER_FAMILY = {
  mp4: 'mp4', m4v: 'mp4', m4a: 'mp4', mov: 'mp4',
  webm: 'webm', mkv: 'webm', weba: 'webm', opus: 'webm', vorbis: 'webm',
  m3u8: 'hls', m4s: 'hls',
  ts: 'mpegts'
};

/** 两条流能不能塞进同一个容器 */
export function sameFamily(a, b) {
  const fa = CONTAINER_FAMILY[String(a || '').toLowerCase()];
  const fb = CONTAINER_FAMILY[String(b || '').toLowerCase()];
  if (!fa || !fb) return null;      // 未知容器，交给调用方按"可能兼容"处理
  return fa === fb;
}

const PREFERRED_LANGS = new Set(['', 'und', 'main', 'original', 'zh', 'zh-cn', 'zh-tw', 'en']);

function languageScore(audio) {
  const lang = String(audio.lang || '').toLowerCase();
  if (!lang) return 30;
  if (PREFERRED_LANGS.has(lang)) return 30;
  return 10;
}

/**
 * 给一条视频轨挑音轨。
 * 评分：容器族兼容(50/100) + 语言(10/30) + 码率/1000 + 是否原声(0/100)
 * 原声权重刻意压过码率：用户更在意"是不是原文"，而不是音轨比特率。
 */
export function pickAudioFor(video, audios) {
  if (!video || !Array.isArray(audios) || audios.length === 0) return null;
  const videoExt = video.extension || '';
  let best = null;
  let bestScore = -1;

  for (const audio of audios) {
    const compatible = sameFamily(videoExt, audio.extension);
    if (compatible === false) continue;                 // 明确不兼容：直接排除
    const containerScore = compatible === true ? 100 : 50;
    const score = containerScore
      + languageScore(audio)
      + (Number(audio.bitrate) || 0) / 1000
      + (audio.isOriginal ? 100 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = audio;
    }
  }
  return best;
}

/**
 * 为整组变体做配对，返回 Map<videoId, audio> 与未被配上的视频列表。
 * 视频轨自己已经带 audioUrl 时保持原样（那是站点明确给出的配对）。
 */
export function pairVariants(variants) {
  const list = Array.isArray(variants) ? variants : [];
  const videos = list.filter((v) => v && !v.isAudio && (v.videoUrl || v.url));
  const audios = list.filter((v) => v && v.isAudio && (v.url || v.audioUrl));
  const pairs = new Map();
  const unpaired = [];

  for (const video of videos) {
    const own = video.audioUrl && video.audioUrl !== (video.videoUrl || video.url) ? video.audioUrl : '';
    if (own) continue;                                  // 已有显式配对
    const chosen = pickAudioFor(video, audios);
    if (chosen) pairs.set(video.id, chosen);
    else unpaired.push(video.id);
  }
  return { pairs: pairs, unpaired: unpaired };
}

/**
 * 合流后的可播放性判断：视频 + 音轨都存在，但容器还是 fMP4 分片时，
 * 当前版本的采样级 remux 处理不了（需要分片重排），要明确拒绝而不是产出坏文件。
 */
export function canMux(videoContainer, audioContainer) {
  const blocked = new Set(['fmp4-segment']);
  if (blocked.has(String(videoContainer || '').toLowerCase())) return false;
  if (blocked.has(String(audioContainer || '').toLowerCase())) return false;
  return true;
}
