/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
/**
 * Edge TTS 音色选项（语音合成页与对话视频页共用）。
 * 微软 Edge TTS 服务支持 400+ 音色，这里列出常用中文（含方言/台粤）
 * 与常用外语。想用列表外的音色，可在语音合成页填「自定义音色 ID」。
 */
export const VOICE_OPTIONS: Array<{ value: string; label: string }> = [
  // ---- 普通话：男声 ----
  { value: "zh-CN-YunxiNeural", label: "男·云希 (沉稳)" },
  { value: "zh-CN-YunyangNeural", label: "男·云扬 (新闻风)" },
  { value: "zh-CN-YunjianNeural", label: "男·云健 (运动风)" },
  { value: "zh-CN-YunfengNeural", label: "男·云枫 (活力)" },
  { value: "zh-CN-YunhaoNeural", label: "男·云浩 (温暖)" },
  { value: "zh-CN-YunxiaNeural", label: "男·云夏 (活泼童声)" },
  { value: "zh-CN-YunyeNeural", label: "男·云野 (阳光)" },
  { value: "zh-CN-YunjieNeural", label: "男·云杰 (阳刚)" },
  { value: "zh-CN-YunzeNeural", label: "男·云泽 (激昂)" },

  // ---- 普通话：女声 ----
  { value: "zh-CN-XiaoxiaoNeural", label: "女·晓晓 (温暖)" },
  { value: "zh-CN-XiaoyiNeural", label: "女·晓伊 (活泼)" },
  { value: "zh-CN-XiaochenNeural", label: "女·晓辰 (平静)" },
  { value: "zh-CN-XiaohanNeural", label: "女·晓涵 (温柔)" },
  { value: "zh-CN-XiaomengNeural", label: "女·晓梦 (开朗)" },
  { value: "zh-CN-XiaomoNeural", label: "女·晓墨 (成熟)" },
  { value: "zh-CN-XiaoqiuNeural", label: "女·晓秋 (舒缓)" },
  { value: "zh-CN-XiaoruiNeural", label: "女·晓睿 (老年)" },
  { value: "zh-CN-XiaoshuangNeural", label: "女·晓双 (童声)" },
  { value: "zh-CN-XiaoxuanNeural", label: "女·晓萱 (甜美)" },
  { value: "zh-CN-XiaoyanNeural", label: "女·晓颜 (温柔)" },
  { value: "zh-CN-XiaoyouNeural", label: "女·晓悠 (温暖)" },
  { value: "zh-CN-XiaozhenNeural", label: "女·晓甄 (温和)" },

  // ---- 方言 ----
  { value: "zh-CN-liaoning-XiaobeiNeural", label: "东北·晓蓓 (辽宁话)" },
  { value: "zh-CN-shaanxi-XiaoniNeural", label: "陕西·晓妮 (陕西话)" },

  // ---- 台湾国语 ----
  { value: "zh-TW-HsiaoChenNeural", label: "台·曉臻 (女)" },
  { value: "zh-TW-HsiaoYuNeural", label: "台·曉雨 (女)" },
  { value: "zh-TW-YunJheNeural", label: "台·雲哲 (男)" },

  // ---- 粤语 ----
  { value: "zh-HK-HiuGaaiNeural", label: "粤·曉佳 (女)" },
  { value: "zh-HK-HiuMaanNeural", label: "粤·曉曼 (女)" },
  { value: "zh-HK-WanLungNeural", label: "粤·雲龍 (男)" },

  // ---- 英语 ----
  { value: "en-US-AriaNeural", label: "美音·Aria (女)" },
  { value: "en-US-JennyNeural", label: "美音·Jenny (女)" },
  { value: "en-US-MichelleNeural", label: "美音·Michelle (女)" },
  { value: "en-US-GuyNeural", label: "美音·Guy (男)" },
  { value: "en-US-ChristopherNeural", label: "美音·Christopher (男)" },
  { value: "en-US-EricNeural", label: "美音·Eric (男)" },
  { value: "en-GB-SoniaNeural", label: "英音·Sonia (女)" },
  { value: "en-GB-LibbyNeural", label: "英音·Libby (女)" },
  { value: "en-GB-RyanNeural", label: "英音·Ryan (男)" },
  { value: "en-AU-NatashaNeural", label: "澳音·Natasha (女)" },
  { value: "en-AU-WilliamNeural", label: "澳音·William (男)" },

  // ---- 日语 ----
  { value: "ja-JP-NanamiNeural", label: "日·Nanami (女)" },
  { value: "ja-JP-KeitaNeural", label: "日·Keita (男)" },

  // ---- 韩语 ----
  { value: "ko-KR-SunHiNeural", label: "韩·SunHi (女)" },
  { value: "ko-KR-InJoonNeural", label: "韩·InJoon (男)" },

];

/** 默认勾选的常用音色：云扬/云健/云夏/晓晓/晓伊/晓萱/晓蓓/晓妮 + 台湾国语 + 粤语 */
export const DEFAULT_FAVORITE_VOICES = [
  "zh-CN-YunyangNeural",
  "zh-CN-YunjianNeural",
  "zh-CN-YunxiaNeural",
  "zh-CN-XiaoxiaoNeural",
  "zh-CN-XiaoyiNeural",
  "zh-CN-XiaoxuanNeural",
  "zh-CN-liaoning-XiaobeiNeural",
  "zh-CN-shaanxi-XiaoniNeural",
  "zh-TW-HsiaoChenNeural",
  "zh-TW-HsiaoYuNeural",
  "zh-TW-YunJheNeural",
  "zh-HK-HiuGaaiNeural",
  "zh-HK-HiuMaanNeural",
  "zh-HK-WanLungNeural",
];

/** 生效的常用音色：从未设置过时用默认勾选列表；设置过则严格按勾选（空数组=不显示任何） */
export function effectiveFavoriteVoices(favs: string[] | undefined): string[] {
  return favs ?? DEFAULT_FAVORITE_VOICES;
}
