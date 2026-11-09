/**
 * Edge TTS 音色选项（语音合成页与对话视频页共用）。
 * 微软 Edge TTS 服务支持 400+ 音色，这里只列出实际会用到的：中文（含方言/台粤）
 * 与日韩；英文音色已下线，需要时按文件里的注释加回来。
 */
export const VOICE_OPTIONS: Array<{ value: string; label: string }> = [
  // ---- 普通话：男声 ----
  // 只留真正用得上的几个（云希/云扬/云健/云夏）。
  // 已下线：云枫 YunfengNeural、云浩 YunhaoNeural、云野 YunyeNeural、
  //        云杰 YunjieNeural、云泽 YunzeNeural —— 需要用就照这个格式加回来。
  { value: "zh-CN-YunxiNeural", label: "男·云希 (沉稳)" },
  { value: "zh-CN-YunyangNeural", label: "男·云扬 (新闻风)" },
  { value: "zh-CN-YunjianNeural", label: "男·云健 (运动风)" },
  { value: "zh-CN-YunxiaNeural", label: "男·云夏 (活泼童声)" },

  // ---- 普通话：女声 ----
  // 只留真正用得上的几个（晓晓/晓伊/晓萱）。
  // 已下线：晓辰 XiaochenNeural、晓涵 XiaohanNeural、晓梦 XiaomengNeural、晓墨 XiaomoNeural、
  //        晓秋 XiaoqiuNeural、晓睿 XiaoruiNeural、晓双 XiaoshuangNeural、晓颜 XiaoyanNeural、
  //        晓悠 XiaoyouNeural、晓甄 XiaozhenNeural —— 需要用就照这个格式加回来。
  { value: "zh-CN-XiaoxiaoNeural", label: "女·晓晓 (温暖)" },
  { value: "zh-CN-XiaoyiNeural", label: "女·晓伊 (活泼)" },
  { value: "zh-CN-XiaoxuanNeural", label: "女·晓萱 (甜美)" },

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
  // 已按需求下线（界面不列英文音色）。需要时把下面几条加回来即可：
  //   en-US-AriaNeural / JennyNeural / MichelleNeural / GuyNeural / ChristopherNeural / EricNeural
  //   en-GB-SoniaNeural / LibbyNeural / RyanNeural
  //   en-AU-NatashaNeural / WilliamNeural

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
