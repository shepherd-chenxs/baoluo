# headless MCP 服务（v1.1.0 起）

宝螺的无窗口形态：把素材下载 / Whisper 转录 / TTS 配音（含本地克隆）/ 对话视频合成 /
爆款拆解 / 分镜提示词 / ModelScope 生图包成 **MCP 工具**，给外部的 agent（班底的数字
员工）调用。**宝螺窗口开不开都行** —— 服务进程与 GUI 彻底分离。

## 形态

```
bandi 数字员工（codex / claude CLI）
   │  stdio（MCP JSON-RPC）
   ▼
bridge.cjs（纯 node，ELECTRON_RUN_AS_NODE=1）        ← bandi 连接器 spawn 的就是它
   │  探测健康；不在就 detached 拉起服务
   ▼
bundle.cjs --service（完整 Electron 运行时，无窗口）
   │  http://127.0.0.1:8765/mcp（POST 一条 JSON-RPC 回一条）
   ▼
能力模块（parser / downloader / transcribe / tts / clone / compose / sniff / storyboard / imagegen）
        └─ 长任务 = detached worker 进程，状态落 <数据目录>/mcp/jobs/<id>.json
```

为什么有这座桥：**Windows 的 Electron 主进程 stdin 不吐数据**（老已知问题），MCP over
stdio 没法直接跑在完整 Electron 里；而抖音解析的离屏窗口、electron.net 又离不开
Electron。所以服务保持完整 Electron，桥用纯 node 做 stdio——班底连接器 spawn 桥即可。
桥无状态、服务常驻：CLI 会话重启、bandi 重启都不丢账（作业状态在文件里）。

## bandi 侧连接器登记

班底 → 设置 → 连接器（或直接写 `<数据目录>/connectors.json`）：

```json
{
  "baoluo": {
    "kind": "mcp",
    "transport": "stdio",
    "command": "E:\\CodeSpace\\github\\baoluo\\node_modules\\electron\\dist\\electron.exe",
    "args": ["E:\\CodeSpace\\github\\baoluo\\dist\\headless\\bridge.cjs"],
    "env": { "ELECTRON_RUN_AS_NODE": "1" },
    "runtimes": ["codex", "claude"],
    "note": "宝螺：素材/配音/成片能力"
  }
}
```

打包版（用户装了宝螺安装包）：

```json
{
  "command": "<安装目录>\\Baoluo.exe",
  "args": ["<安装目录>\\resources\\app.asar.unpacked\\dist\\headless\\bridge.cjs"]
}
```

- 桥按两种目录布局自动找 electron 与 bundle；装在非默认位置用
  `BAOLUO_MCP_ELECTRON` 指到 Baoluo.exe（连接器 env 里加一条即可）。
- 端口默认 8765，`BAOLUO_MCP_PORT` 可改（两处要一致：桥与服务读同一个变量）。
- 数据目录与宝螺 GUI 同一份（`%APPDATA%\Baoluo`，或 `BAOLUO_DATA_DIR` 显式指定）。
  ⚠️ 服务**启动那一刻**的环境决定它用哪份数据目录 —— 改了 `BAOLUO_DATA_DIR` /
  `BAOLUO_MCP_PORT` 之后要把常驻服务重启一遍（杀掉旧的，桥下次会重新拉）。

## 工具表（9 能力 + 3 作业）

| 工具 | 做什么 | 形态 |
|---|---|---|
| baoluo_parse_link | 分享文本 → 标题/作者/时长/播放地址（抖音/快手/B站/小红书） | 同步，秒级 |
| baoluo_download | 下载无水印原片 | 后台作业 |
| baoluo_transcribe | 本地 Whisper 转录 → transcript.txt | 后台作业 |
| baoluo_write_script | DeepSeek（或 CLI 运行时）写双人对话脚本 → script.txt | 后台作业 |
| baoluo_tts | 文本 → mp3/wav（在线音色或 `clone:<id>` 本地克隆；不传音色用宝螺默认） | 后台作业 |
| baoluo_compose_dialogue | 脚本+双角色图+双音色 → mp4（逐句配音/拼画面/字幕） | 后台作业 |
| baoluo_sniff | 爆款拆解 → 爆款拆解.txt | 后台作业 |
| baoluo_write_storyboard | 主题 → 分镜旁白+画面提示词 → 分镜提示词.txt | 后台作业 |
| baoluo_generate_image | ModelScope 生图 → png（豆包引擎不 headless） | 后台作业 |
| baoluo_job_status / list / cancel | 查进度 / 列表 / 取消 | 同步 |

- 长任务**提交即返回 jobId**，用 `baoluo_job_status` 轮询；完成后 `outputPath`
  是产物完整路径。
- 宝螺**一次只跑一个作业**（合成/下载/识别都吃 CPU 磁盘，并发没有好处）；
  提交第二个会被拒并提示先等或先取消。
- 取消是协作式的：写 `cancelRequested` 标志，worker 在下一个进度节拍停手。

## 作业生命周期

```
提交（MCP 服务进程）→ job 文件 state=queued → detached worker 进程
worker：state=running → 每个进度节拍写 progress{percent,message} 并检查取消标志
      → 终态 done（outputPath/note/data）/ failed（error）/ cancelled
任何进程（新旧 MCP 服务、worker）读写同一份 job 文件（原子写：tmp+rename）
```

## 已知边界

- **豆包生图不做 headless**（登录态 + 离屏浏览器窗口是产品的一部分）；生图走
  ModelScope 引擎（设置 → 生图 → 引擎切 ModelScope，填 ms- 令牌）。
- **本地克隆音色**依赖 Genie-TTS 服务（宝螺「设置 → 声音克隆」里启用，127.0.0.1:45231）；
  服务没在跑时 clone 作业会失败并给出指路文案。
- **抖音解析是对抗性接口**，网页改版可能断 —— 失败会给出人话错误，让调用方降级
  （换链接/报雇主），不要傻重试。
- 服务只绑 127.0.0.1，无鉴权 —— 本机工具的口径（与 Genie/whisper 一致）；
  不要把端口暴露到局域网。

## 开发

```
npm run build:headless     # esbuild → dist/headless/{bundle,bridge}.cjs
npm run test:headless      # 离线协议 + 作业生命周期冒烟（已在 npm test 链里）
node scripts/e2e-headless-tts.cjs   # 真网络 E2E：合一条真配音（需要联网）
```

改到能力层（compose/downloader/sniff）时，回归跑 `npm test` + `npm run test:composer`
+ `node scripts/smoke-dialogue.cjs`。
