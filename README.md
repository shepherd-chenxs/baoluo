# 宝螺 🐚

代号：Baoluo —— 素材捕手 + 语音合成 + **对话视频生成**（一站式桌面工具，Electron）。

把两个工具合并到了一个 App：

| 功能 | 来源 | 说明 |
|------|------|------|
| 素材捕手（抖音无水印下载等） | 原 little-bee | 粘贴分享文本 → 一键下载 mp4 |
| 文案提取（Whisper） | 原 little-bee | 下载后一键转录音视频文案 |
| **对话视频生成** | **集成自 laodeng** | 输入命理师/顾客对话脚本 → 一键生成配音视频 |
| **AI 一键写脚本** | 新增 | DeepSeek 自动按主题写对话脚本 |
| **变声器** | 新增 | 上传音频/视频 → 识别原文案 → 用指定音色重新配音（在线音色或本地克隆） |
| **工作台（agent）** | 新增 | 说一句话 → 自动拆成任务卡 → 逐步执行，每步可改参数、可单独重跑 |

UI 是一行细顶栏（和最小化/最大化/关闭同一行）：**工作台** ｜ 素材捕手 · **视频生成** · **语音处理** · **设置**。
顶栏只有一级；「视频生成」「语音处理」「设置」的子菜单都在**内容区左侧**那一列（有分隔线，跟着滚）：
视频生成下是图文解说 / 对话模式 / 热点成片 / 爆款嗅探，语音处理下是语音合成 / 语音识别 / 变声器，
设置下是通用 / 字幕 / 音色 / 声音克隆 / AI 服务 / 关于。
各功能可独立使用，互不干扰。

其中「视频生成」是带子菜单的目录项，下分两个独立页面：**图文解说**（多图 + 解说员配音）和**对话模式**（两张角色图 + 双方对话）；
两页各记各的模板配置与脚本草稿。同样带子菜单的还有「设置」。

**图文解说**采用与「热点成片」一致的分镜模式：一个镜头 = 一张图 + 一段解说词 + **一个解说员**（图片可直接拖入），
音色与语速/音调/音量都在镜头卡片里单独设置，逐镜试听，成片顺序即镜头顺序；
想在同一段里换音色，就拆成两个镜头。

## 工作台（agent 模式）

默认首页。说一句话 → 生成一张**任务卡**（要跑哪几步、每步什么状态，全摊开）→ 逐步执行。
和通用聊天助手不同的是：**产物是文件**，所以每一步的结果都落盘、都能单独打开、都能单独重跑；
某一步不满意，只重跑那一步，前面下载好的素材不用再来一遍。

三条剧本（`src/main/agent/workflows.ts`，硬编码，执行时不经过模型）：

| 你说 | 拆成 |
|------|------|
| 贴一条视频链接 | 解析链接 → 下载无水印原片 → 提取文案 |
| 贴链接 + 说「对话」 | 解析 → 下载 → 提取文案 → 写对话脚本 → 合成视频 |
| 说一个主题（如「对话 事业运」） | 写对话脚本 → 合成视频 |
| 说「图文解说 职场焦虑」/「按热点写一条成片」 | 生成分镜（旁白 + 每镜画面提示词）→ 你生图 → 选图合成 |
| 拖一个音频/视频进来说「变声」 | 识别文案 → 按目标音色重新念 |
| 贴一条爆款链接说「拆解」/ 打 `@爆款` | 拉文案 → 拆出开头钩子 / 叙事结构 / 可复用方法 + 同方法选题 |

第三条走的其实就是**热点成片**那条链路：AI 出分镜，每镜给一段旁白和一条画面提示词，
提示词另存成 `分镜提示词.txt` 方便拿去豆包/即梦生图；图回来放进每一镜，再一键合成解说视频。
分镜会同时落进「热点成片」页，两边的图是同一批。

分流靠规则（`src/main/agent/router.ts`），不花 token；整条链里**只有「写对话脚本」和「生成分镜」两步会调模型**（DeepSeek），
下载、转录、配音、合成全是确定性代码。
接口方面：`src/main/agent/tools.ts` 是工具表，`runner.ts` 是执行器，任务卡存在 `userData/agent/tasks.json`，
下载的原片在 `userData/agent/materials/`，产物都在工作台里能直接打开。

设计取舍见 [产品形态设计](./doc/Agent化改造-产品形态设计.md)、[可行性方案](./doc/Agent化改造-可行性方案.md)、
[低 token 方案](./doc/Agent化改造-低token方案.md)。

---

## 开发

```bash
# Windows / 国内环境（默认下载 Electron 二进制可能被断流，用镜像更快）
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
npm install

# npm install 完成后会自动运行 postinstall，下载两个运行时（都不入库）：
#   - whisper.cpp 二进制（约 8MB）        → resources/whisper/
#   - 便携版 Python + 语音合成依赖（约 580MB）→ resources/python/
# 若国内下载失败，可手动执行（幂等，可重复跑）：
node scripts/setup-whisper.cjs
node scripts/setup-python.cjs

# 运行环境怎么分发（安装包不背 580MB 运行时）：
#   - resources/python 只用于开发，不随安装包分发
#   - 正式版由用户首次使用声音克隆时下载便携版 Python（约 37MB，多个国内镜像）
#   - 依赖由用户端从国内 PyPI 镜像安装
#   - 只有 jieba_fast 用户端装不了（PyPI 只有源码包、需要 C 编译器），
#     由 setup-python.cjs 编译好放到 resources/wheels（约 7MB）随安装包分发

npm run dev            # 同时启动 Vite + Electron
```

**首次使用对话视频生成**需要 Edge TTS 在线服务（依赖 node-edge-tts，
首次合成时会调用 wss://speech.platform.bing.com/...）。
DeepSeek 集成需要填 API Key（在「对话视频」→ 「完整设置」里填一次即可，
本地保存到 userData/dialogue-settings.json）。

> **密钥说明**：仓库里不含任何 API Key。你填的 Key 只写在本机
> `%APPDATA%\Baoluo\dialogue-settings.json`（明文，请自行保管），不会上传到任何服务器；
> 该文件和 `.env*`、`cookies/`、`*.pem` 等已在 `.gitignore` 中排除，提交前请勿加 `-f` 强制入库。
> 豆包生图走的是浏览器登录态（`<数据目录>/Partitions/doubao`），同样只存在本机。

## 打包

```bash
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
npm run build
npx electron-builder --win --x64 --dir

# 产出：release/win-unpacked/Baoluo.exe（直接双击可运行）

# 完整安装包（NSIS）：
npm run dist
# 产出：release/宝螺 Setup <版本号>.exe（文件名里的版本号取自 package.json）
```

## 版本号

版本号**只有一个来源**：`package.json` 的 `version`。窗口标题、关于页、安装包文件名都从它推导，
升级时只改这一处（`package-lock.json` 由 npm 一并同步）：

```bash
npm run bump -- 0.8.3     # 等价于 npm version --no-git-tag-version 0.8.3
```

- 主进程：`app.getVersion()`（Electron 读的就是 package.json）
- 渲染层：构建时由 `vite.config.ts` 注入的全局常量 `__APP_VERSION__`（见 `src/renderer/views/AboutView.tsx`）
- 安装包：electron-builder 用 package.json 的版本命名产物

## 对话视频功能详解

UI 来自 laodeng PyQt6 项目的 1:1 React 翻译。下面是每个面板的能力：

### 👤 人物图片
两张人物图（命理师 / 顾客），用对话脚本里的称呼决定显示哪张。点「选择图片」弹原生文件对话框。

### ⚙ 语音与字幕
- **命理师/顾客音色**：从 12 种 Edge 中文音色里挑选（男/女、普通话/方言）
- **字幕字号 / Y 位置**：在 0.5..0.99 范围调节
- 完整设置（折叠）：API Key、字幕颜色、背景颜色与透明度

### 📝 对话脚本
- 直接在文本框里按 命理师：xxx / 顾客：xxx 格式输入
- 解析 400ms 防抖，识别成功的话会列出每行 + 警告
- **✨ AI 一键写脚本**：填一个主题（例如「事业运」「感情婚姻」），调 DeepSeek，按老 laodeng 系统提示词风格写 8-14 行对话

### 输出目录 & 项目
- 输出目录默认是 userData 下的 dialogue-output/（每次合成内含 udio/ 与 ideo/）
- 输出路径可在 设置 → 通用设置 中修改；生成页可一键「打开输出目录」
- 「保存模板」把当前配置（图片/音色/运镜/画布）存入 settings.json，下次切换模板自动应用

### 🎬 生成视频
进度分三段：
1. 解析脚本
2. 顺序合成 TTS（每完成一行累计一格，最多 95%）
3. ffmpeg 拼接音视频

### 📺 预览
合成结束后直接渲染到 <video> 标签，可拖进度 / 全屏。
视频文件也保留在 outputDir/video/，方便传到别处。

## 技术栈差异（原 laodeng → 本项目）

| 关注点 | laodeng | 本项目 |
|--------|---------|--------|
| GUI | PyQt6 | Electron + React |
| TTS | Python edge-tts | Node node-edge-tts（同一协议，WebSocket） |
| 视频合成 | MoviePy | 直接调 ffmpeg-static + 自写 ASS 字幕滤镜 |
| 配置存储 | 项目内 settings.json | userData/settings.json（模板/音色/通用配置） |
| 配置 | 项目内 settings.json | userData/dialogue-settings.json（自动迁移老 settings.json） |
| 图片选择 | PyQt QFileDialog | Electron 原生 dialog |
| 设置面板 | QDialog | React 表单 + 折叠面板 |
| 视频预览 | QMediaPlayer | HTML5 <video> |

整体流水线：parser → tts（WebSocket）→ ffmpeg render segments → ffmpeg concat demuxer → mp4。

## 迁移说明（来自老 laodeng 用户）

老 laodeng 的两个文件会被自动识别并迁移到 Electron 标准 userData 目录：

| 老路径 | 新路径 |
|--------|--------|
| <laodeng>/settings.json | %APPDATA%/Baoluo/dialogue-settings.json |

改名迁移：旧版「小蜜蜂 / XiaoMiFeng」以及开发代号 `bee` 的历史用户数据目录，会在首次启动时自动合并到 `%APPDATA%/Baoluo`（只补缺文件、不覆盖新数据）。

启动时若新文件不存在、且老文件可读，自动一次性导入，之后老文件可删除。

## 项目结构

```
src/
  main/                          # Electron 主进程（Node）
    index.ts                   # 创建窗口 + 注册 bee-file:// 协议
    userData.ts              # 统一数据目录 %APPDATA%/Baoluo + 旧目录一次性迁移
    ipc.ts                     # 全部 IPC handlers（抖音 + 对话）
    downloader.ts              # net.request 流式下载
    parser/                    # 抖音分享页解析
    dialogue/                  # 集成自 laodeng 的对话视频生成
      parser.ts              # 脚本解析（命理师/顾客识别）
      tts.ts                 # node-edge-tts 包装（重试、顺序）
      composer.ts            # ffmpeg 流水线（image+audio+ass → mp4）
      compose.ts             # 对外入口：编排 parse→tts→compose
      settings.ts            # settings.json I/O（含迁移）
      scriptGen.ts           # DeepSeek 一键写脚本
      ffmpeg.ts              # ffmpeg-static 共用层（含进度解析）
    transcribe.ts              # Whisper.cpp 集成（抖音文案提取）
  preload/index.ts               # contextBridge 暴露 window.bee + window.dialogue + window.media
  shared/dialogue-types.ts       # 前后端共享业务类型
  renderer/
    App.tsx                    # 顶部 Tab 容器
    views/
      DouyinView.tsx         # 原抖音下载界面
      DialogueView.tsx       # 对话视频生成界面（laodeng 1:1）
    components/
      TabBar.tsx             # Tab 切换
    styles.css
```

scripts/smoke-dialogue.cjs —— 验证 TTS + ffmpeg 拼装的最小烟测
scripts/e2e-dialogue.cjs —— 跑完整 parse→tts→compose 端到端，给一个 4 行脚本输出 mp4

## 免责声明

本项目以 MIT 协议授权，以下为使用须知，**不构成对 MIT 授权条款的额外限制**。使用者对自己的行为承担全部责任：

- **素材来源**：请遵守各内容平台（抖音、B 站等）的服务条款与 `robots` 约定，勿抓取、搬运、分发未经授权的内容。
- **声音与肖像**：语音克隆、变声功能只能用于自己拥有权利或已获明确授权的声音；用他人声音制作、传播内容在多地已有判例风险，责任由使用者自负。
- **AI 生成内容**：文案与配图来自第三方模型，输出质量与版权状态由模型方决定，商用前请自行核验。
- **不含任何鉴权**：本开源版已移除授权/激活模块，生图等能力需要你自备并填入自己的 API Key（BYOK）。

## 许可证

本项目自有代码以 [MIT](LICENSE) 授权，Copyright (c) 2026 宝螺 / Baoluo contributors。

第三方组件的许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。其中需要留意的是：
**安装包内含以 GPL-3.0-or-later 分发的 FFmpeg 可执行文件**（独立进程调用，未修改），
分发安装包时须一并提供其许可与源码获取地址，详见该文件的第三节。
