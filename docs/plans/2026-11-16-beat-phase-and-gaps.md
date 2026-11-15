# 逐曲起拍对齐与曲间间隙

## 用户要求与诊断

用户要求曲间加入间隙以重置节拍，并修复曲内持续偏移半拍或几分之一拍的问题。现有导出从项目零点渲染一条固定网格，试听同时使用 HTMLAudio 与 AudioContext 两套播放时钟。音乐首拍位置尚未进入逐曲调度。

## 行为

- 默认曲间间隙 2 秒，可设 0–30 秒。相邻曲目之间加入间隙，首尾不附加间隙。间隙内两轨静音。
- 每曲使用自身的实际鼓点锚点重置固定步频网格。每个编排项提供独立 phase_offset_ms，正值延后 click，负值提前。默认 0，支持 -1000..1000 ms、10 ms 微调、半拍切换和恢复自动。
- 拍点公式为 phase = (anchor_seconds + phase_offset_ms / 1000) mod (60 / cadence)，第 n 个 click 位于曲目开始时间 + phase + n * 60 / cadence。每曲结尾截断 click 尾音，间隙全静音。
- 步频与曲目速度匹配时，固定网格按鼓点锚点对齐。界面标明待适配或起拍判断较弱的素材，沿用制作适配版和手动 BPM。变速曲、自由节奏和弱节奏应呈现分析可靠程度。

## 鼓点锚点

Track 新增 alignment，字段为 {anchor_seconds, bpm, confidence, drift_ms, status}。anchor_seconds、bpm、drift_ms 可空，confidence 范围 0..1，status 为 pending、detected、uncertain 或 unavailable。anchor_seconds 是实际音频中一个音乐拍点的绝对位置。drift_ms 表示采样片段拍点对拟合网格的残差参考。

使用频谱变化与周期性提取粗拍点，在原始 PCM 中局部细化攻击沿。参考低频鼓点与宽频证据，避免简单使用 STFT 帧时间作为精确起拍。按绝对时间比较前中后片段，稳健拟合周期，必要时细化自动 BPM，并降低不稳定节奏的置信度。

导入和变速生成后分析实际输出文件。POST /api/tracks/{id}/analyze 补齐历史 pending 的 tempo 或 alignment。手动 BPM 更新按新周期刷新起拍分析，并保持并发修改优先级。

## 统一时间线与试听

新增 GET /api/media/{id}/chunk，参数 start_frame >= 0、frame_count 为 1..441000，默认 220500。返回所请求范围的 44.1 kHz、双声道、16-bit WAV，末尾允许较短片段，越过文件末尾返回 416。

PreviewEngine 改为按需读取 5 秒 PCM 分块，保持当前和接下来少量缓存。BGM BufferSource 与 click 使用同一 AudioContext 的项目时间锚点。两轨保留独立 GainNode。曲间间隙、seek、暂停、恢复、自然跨曲均使用同一时间线。缓冲错误统一停止两轨，防止时钟分别推进。

时间线按整数采样帧建立曲目区间与间隙。metadata 和相位微调更新只刷新节拍调度，实际媒体、排序或间隙变化按既有编排变更规则处理。

## 项目与导出兼容

- MixSettings 新增 gapSeconds，默认 2。localStorage 保留 trackIds、entryIds，新增 phaseOffsetsMs。旧项目补默认值，重复素材仍有独立编排项与相位。
- ExportRequest 新增 gap_seconds，默认 2，范围 0..30。
- TrackReference 新增 phase_offset_ms，默认 0，范围 -1000..1000。
- 导出创建时快照每曲长度、锚点、相位偏移和间隙。BGM concat 交替加入静音 WAV，click 按逐曲区间渲染。原有 gain、MP3/WAV、进度、取消与失败终态规则继续适用。

## 分工

1. 音频分析代理负责 models、tempo、alignment、storage、app 和对应分析/API测试，包含分块接口。
2. 导出代理负责 audio、jobs、旧 test_api 及新导出测试，验证 gap 静音与逐曲相位。
3. 前端代理负责统一分块试听、逐曲时间线、相位控件、间隙设置、持久化及前端测试。
4. 主代理负责集成审阅、带非零首拍与长时音频验收、浏览器与手机交互、README、GitHub 发布和本地服务更新。

## 验收

- 165 BPM 且首拍位于 173 ms 的脉冲，自动锚点误差为数毫秒，网格渲染按整数采样定位。
- 两首不同相位、任意长度间隙，第二首独立起拍，间隙两轨全静音，音频总帧数正确。
- 实际 atempo 输出重新测量相位，长时检测避免平均 BPM 细小误差积累。
- 半拍、双拍、正负微调、跨周期取模、metadata与旧项目、重复素材、导出参数快照。
- 浏览器验证 BGM/click 同时钟，seek 到间隙和曲内后相位正确，微调过程中 BGM 持续，缓存随长音轨长度保持有界。
