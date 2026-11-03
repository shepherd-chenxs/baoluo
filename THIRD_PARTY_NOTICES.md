# 第三方组件与许可

本项目**自有代码**以 MIT 授权（见 [LICENSE](./LICENSE)）。
随安装包分发、或在运行期下载的第三方组件各有自己的许可，此处逐一列明，以履行相应许可的告知义务。

---

## 一、随安装包分发

| 组件 | 来源 / 版本 | 许可 | 说明 |
|---|---|---|---|
| **FFmpeg** | `ffmpeg-static` 5.x | **GPL-3.0-or-later** | 预编译可执行文件，未做修改；由主进程以独立进程调用（见下方第三节） |
| Electron（含 Chromium、Node.js） | Electron 30.x | MIT + BSD-3-Clause 等 | Chromium 的完整许可文本见 Electron 发行包内的 `LICENSE` 与 `LICENSES.chromium.html` |
| React / ReactDOM | 18.x | MIT | 仅渲染进程使用 |
| node-edge-tts | 1.2.x | MIT | Edge TTS 的 WebSocket 客户端 |
| opencc-js | 1.4.x | MIT AND Apache-2.0 | 含 OpenCC 转换数据 |
| jsonrepair | 3.15.x | ISC | 模型输出 JSON 修复 |
| whisper.cpp 二进制 | `whisper-blas-bin-x64`（ggml-org/whisper.cpp） | MIT | 由 `postinstall` 下载到 `resources/whisper/` |
| jieba_fast wheel | PyPI | MIT | 预编译 wheel，位于 `resources/wheels/`，随包分发 |

## 二、运行期下载（不入库，也不随安装包分发）

| 组件 | 来源 | 许可 |
|---|---|---|
| 便携版 Python 运行时 | python.org embeddable package | PSF License |
| Whisper ggml 模型 | Hugging Face（OpenAI Whisper 权重） | MIT |
| 声音克隆模型（Genie-TTS） | Hugging Face 镜像 | 以上游仓库声明为准 |

## 三、GPL 组件说明（FFmpeg）

FFmpeg 以 **GPL-3.0-or-later** 分发。本项目通过 `spawn` 以独立进程调用 `ffmpeg.exe`，仅做进程间调用，不与其链接，本项目的源代码不因包含它而被 GPL 覆盖；但**分发包含 FFmpeg 的安装包时，仍须遵守 GPL-3.0 的相应义务**：

1. **许可告知** —— 本文件随安装包一并提供 FFmpeg 的许可信息；
2. **源码获取** —— 对应源码可从下列地址取得：
   - `ffmpeg-static`（含构建脚本与其指向的预编译发布）：<https://github.com/eugeneware/ffmpeg-static>
   - FFmpeg 上游源码：<https://ffmpeg.org/download.html> / <https://git.ffmpeg.org/ffmpeg.git>
3. **二进制未修改** —— 分发的 `ffmpeg.exe` 为上游预编译产物，未作任何改动。

> 如果你只想分发 LGPL 构建的 FFmpeg：替换 `node_modules/ffmpeg-static/ffmpeg.exe` 为 LGPL 版本即可，
> 但需注意 LGPL 构建不含 `libx264` 等 GPL 编码器，部分编码参数会不可用。

## 四、服务与内容（非软件许可，但同样适用）

- **Edge TTS**（微软在线语音合成）：通过 `node-edge-tts` 调用，需遵守微软的服务条款；
- **豆包 / 抖音 / B 站等平台**：仅通过本机浏览器登录态访问，需遵守各平台的服务条款与 `robots` 约定；
- **内置角色模板图**（`resources/template-assets/`）：项目自有素材，随 MIT 授权。

---

如发现本文件遗漏或标注有误，欢迎提交 Issue 更正。
