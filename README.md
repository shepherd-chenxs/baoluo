# 宝螺 🐚

代号：Baoluo —— **对话视频生成** + 语音合成 + 文案工具（一站式桌面工具，Electron）。

| 功能 | 说明 |
|------|------|
| **对话视频生成** | 输入双人对话脚本 → 一键生成配音视频 |
| **图文解说** | 多图 + 分镜旁白，逐镜配音合成 |
| **AI 一键写脚本** | 按主题自动写对话脚本 / 生成分镜 |
| **文案提取（Whisper）** | 本地转录音视频文案，不联网 |
| **变声器** | 上传音频/视频 → 识别原文案 → 用指定音色重新配音（在线音色或本地克隆） |
| **爆款嗅探** | 给一段本地音视频 → 拆出开头钩子 / 叙事结构 / 可复用方法 |
| **工作台（agent）** | 说一句话 → 自动拆成任务卡 → 逐步执行，每步可改参数、可单独重跑 |

> **本工具不解析、不下载任何平台的内容。** 所有需要素材的功能都由你自己提供本地音视频文件。
> 素材怎么来请你自行处理，并遵守相应平台的服务条款与版权规定。

UI 是一行细顶栏（和最小化/最大化/关闭同一行）：**工作台** ｜ **视频生成** · **语音处理** · **设置**。
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
某一步不满意，只重跑那一步，前面已经跑出来的文案、脚本不用再来一遍。

四条剧本（`src/main/agent/workflows.ts`，硬编码，执行时不经过模型）：

| 你说 | 拆成 |
|------|------|
| 说一个主题（如「对话 职场焦虑」） | 写对话脚本 → 配角色画面 → 合成视频 |
| 说「图文解说 职场焦虑」/「按热点写一条成片」 | 生成分镜（旁白 + 每镜画面提示词）→ 你生图 → 选图合成 |
| 拖一个音频/视频进来说「变声」 | 识别文案 → 按目标音色重新念 |
| 拖一个音频/视频进来说「拆解」/ 打 `@爆款` | 转文案 → 拆出开头钩子 / 叙事结构 / 可复用方法 + 同方法选题 |

第二条走的其实就是**热点成片**那条链路：AI 出分镜，每镜给一段旁白和一条画面提示词，
提示词另存成 `分镜提示词.txt` 方便拿去任意生图工具；软件也内置了一键生图（走官方 HTTP 接口），图回来放进每一镜，再一键合成解说视频。
分镜会同时落进「热点成片」页，两边的图是同一批。

分流靠规则（`src/main/agent/router.ts`），不花 token；整条链里**只有「写对话脚本」和「生成分镜」两步会调模型**，
转录、配音、合成全是确定性代码。
接口方面：`src/main/agent/tools.ts` 是工具表，`runner.ts` 是执行器，任务卡存在 `userData/agent/tasks.json`，
产物都在工作台里能直接打开。

设计取舍见 [产品形态设计](./doc/Agent化改造-产品形态设计.md)、[可行性方案](./doc/Agent化改造-可行性方案.md)、
[低 token 方案](./doc/Agent化改造-低token方案.md)。

> 这三份是当时的设计稿，里面的「解析链接 → 下载原片」两步后来随素材捕手一起移除了；
> 读的时候请按本文上面的剧本表理解现状。文档保留原样是为了留下决策过程，不做追改。

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

**首次使用一键生图**需要自备 ModelScope 的访问令牌（BYOK，软件不含任何授权/激活）：
到 [ModelScope 访问令牌页](https://modelscope.cn/my/myaccesstoken) 申请，复制 default 那条，
在「设置 → AI 服务 → 生图引擎」里填上即可。生图走 ModelScope API-Inference 的官方 HTTP 接口
（异步任务：提交 → 轮询 → 下载），免费额度会被限流（HTTP 429），软件已做退避重试。
没填令牌时相关入口会直接给出「去哪儿补」的提示，不会静默失败。

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

下面是每个面板的能力：

### 👤 人物图片
两张人物图（甲方 / 乙方），用对话脚本里的称呼决定显示哪张。点「选择图片」弹原生文件对话框。

> 内置模板自带的那两张形象图**由 AI 文生图生成**（平台：魔搭 ModelScope），不是任何真实人物的照片。
> 具体模型与提示词未留存，来源与核验情况详见 [ATTRIBUTION.md](ATTRIBUTION.md)。
> 用于对外发布的商业内容前，请自行确认生成平台条款与肖像相似性风险，或直接换成自己的素材。

### ⚙ 语音与字幕
- **甲方/乙方音色**：从 12 种 Edge 中文音色里挑选（男/女、普通话/方言）
- **字幕字号 / Y 位置**：在 0.5..0.99 范围调节
- 完整设置（折叠）：API Key、字幕颜色、背景颜色与透明度

### 📝 对话脚本
- 直接在文本框里按 甲方：xxx / 乙方：xxx 格式输入（角色名随便起，按出现顺序认前两个说话人）
- 解析 400ms 防抖，识别成功的话会列出每行 + 警告
- **✨ AI 一键写脚本**：填一个主题（例如「职场焦虑」「亲密关系」），调模型写 8-14 行对话

### 输出目录 & 项目
- 输出目录默认是 userData 下的 dialogue-output/（每次合成内含 `audio/` 与 `video/`）
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

## 技术选型

| 关注点 | 本项目 |
|--------|--------|
| GUI | Electron + React |
| TTS | node-edge-tts（WebSocket，见「第三方组件」） |
| 语音识别 | whisper.cpp（postinstall 下载） |
| 视频合成 | 直接调 ffmpeg + 自写 ASS 字幕滤镜 |
| 配置存储 | userData/settings.json（模板/音色/通用配置） |
| 图片选择 | Electron 原生 dialog |
| 设置面板 | React 表单 + 折叠面板 |
| 视频预览 | HTML5 <video> |

整体流水线：parser → tts → ffmpeg render segments → ffmpeg concat demuxer → mp4。

## 数据目录

默认数据目录是 `C:\Baoluo\data`（可在「设置 → 通用设置 → 数据目录」换盘，路径记在默认目录的
`data-root.txt` 指针文件里）；老版本的 `%APPDATA%\Baoluo` 若已有数据会被就地认领。
旧版扁平配置 `dialogue-settings.json` 在首次读取时一次性导入 `settings.json`，之后老文件可删除。

## 项目结构

```
src/
  main/                      # Electron 主进程（Node）
    index.ts                 # 创建窗口 + 注册自定义文件协议
    userData.ts              # 统一数据目录（可换盘）
    ipc.ts                   # 全部 IPC handlers
    http.ts                  # 主进程侧的公开接口请求（热榜用）
    ai-client.ts / ai-json.ts# 模型调用与返回内容修复
    transcribe.ts            # whisper.cpp 集成（本地音视频转文案）
    hot.ts                   # 各平台公开热榜聚合（只读榜单接口，不取内容）
    agent/                   # 工作台：router（规则分流）/ runner / tools / workflows
    dialogue/                # 对话视频生成：parser / tts / composer / compose / settings
    imagegen/                # 生图（单张、批量、ModelScope 引擎）
    storyboard/              # 分镜（AI 出旁白 + 画面提示词）
    sniff/                   # 爆款嗅探（本地音视频 → 转写 → 拆方法）
    records/                 # 历史记录
  preload/index.ts           # contextBridge 暴露给渲染层的 API
  shared/                    # 前后端共享类型与预设
  renderer/
    App.tsx                  # 顶栏 + 路由
    views/                   # 对话模式 / 图文解说 / 热点成片 / 爆款嗅探 / 语音合成 / 变声器 / 设置…
    components/              # 侧栏、任务卡、分镜工作台等
```

scripts/smoke-dialogue.cjs —— 验证 TTS + ffmpeg 拼装的最小烟测
scripts/e2e-dialogue.cjs —— 跑完整 parse→tts→compose 端到端，给一个 4 行脚本输出 mp4

## 第三方组件与许可

| 组件 | 许可 | 获取方式 |
|------|------|----------|
| ffmpeg（经 `ffmpeg-static`） | GPL-3.0-or-later | `postinstall` 下载，随安装包分发 |
| whisper.cpp | MIT | `postinstall` 下载，不入库 |
| node-edge-tts | MIT | npm 依赖 |
| Genie-TTS / GPT-SoVITS（代码） | MIT（上游，见 `doc/变声器功能-开源方案调研.md`） | 用户首次使用声音克隆时下载，不入库 |

> **模型权重请另行核对**：上游仓库的代码是 MIT，不代表它托管的模型权重也是 MIT。
> 商用前请确认你所下载的那份权重（含训练数据的授权）的许可条款。

> **关于 ffmpeg**：`ffmpeg-static` 下载的是 `6.1.1-essentials_build-www.gyan.dev`，
> 构建参数含 `--enable-gpl --enable-version3`（并链接 x264 / x265 / libvidstab），
> 而本项目的成片链路用的就是 `-c:v libx264`。
> **本项目自身已采用 GPL-3.0，与这个 GPL 构建兼容**，随安装包分发它属于正常义务范围：
> 分发二进制时必须同时提供对应源码（本仓库即是），并接受下游同样以 GPL-3.0 流转。

> **关于在线语音合成**：默认引擎走的是第三方未公开接口，可能随时失效，也不保证符合其服务条款。商用请自行替换为有授权的 TTS 服务。

> **关于在线语音合成**：默认引擎走的是第三方未公开接口，可能随时失效，也不保证符合其服务条款。商用请自行替换为有授权的 TTS 服务。

## 免责声明

本项目仅供个人学习与本地备份用途。使用者对自己的行为承担全部责任：

- **素材来源**：本工具不解析、不下载任何平台的内容，需要素材的功能都由你自己提供本地文件。
  请确保你对喂进来的素材拥有相应权利，并遵守各内容平台的服务条款与 `robots` 约定，
  勿抓取、搬运、分发未经授权的内容。
- **声音与肖像**：语音克隆、变声功能只能用于自己拥有权利或已获明确授权的声音；用他人声音制作、传播内容在多地已有判例风险，责任由使用者自负。
- **AI 生成内容**：文案与配图来自第三方模型，输出质量与版权状态由模型方决定，商用前请自行核验。
- **不含鉴权**：本仓库不含任何授权/激活逻辑，所有模型与生图能力都需要你自备并填入自己的 API Key（BYOK）。

## 许可证

Copyright (c) 2026 宝螺 / Baoluo contributors

本项目以 **GPL-3.0-only** 授权（全文见 [LICENSE](LICENSE)），并依 GPL-3.0 §7 追加了少量条款
（见 [ADDITIONAL_TERMS.md](ADDITIONAL_TERMS.md)）。

你可以自由地运行、研究、修改本软件并分发副本，**包括用于商业目的**——
唯一的核心义务是：再分发的修改版或衍生作品，必须同样以 GPL-3.0 开源并提供对应源码。

附加条款只做两件事，都不影响你怎么用这个软件：

| | 要求 |
|---|---|
| **来源署名** | 分发时保留版权声明与"这部分代码来自宝螺"的说明（§7(b)） |
| **产品身份** | 修改版对外分发时，不得再叫"宝螺 / Baoluo"、不得沿用本项目图标（§7(c)(d)(e)） |

第二条是保护**双方**的：你改的东西不用替原版背锅，原作者也不必为他人改动承担指控。

> 一句话：随便用、随便改、随便卖。但代码来源要认账，产品身份要撇清。

### 关于贡献

欢迎 PR。提交即表示你同意自己的贡献按本项目现有的许可（GPL-3.0-only + 上述附加条款）发布。

