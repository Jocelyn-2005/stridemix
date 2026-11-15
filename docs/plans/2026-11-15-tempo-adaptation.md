# 曲目节奏参考与步频适配

## 需求与实现计划

用户要求为本地文件、视频链接与歌名搜索选定的曲目提供节奏对应的步频参考，并提供制作变速版的按钮以适配当前步频。延续已有本地 React/FastAPI/FFmpeg 架构。

## 音频规则

- 所有导入入口在得到归一化音频后进行 BPM 分析。最多取前、中、后三个 30 秒片段，以 NumPy spectral flux 与自相关检测周期，逐段处理以限制内存占用。
- 显示估算 BPM、可靠程度与半拍、原拍、双拍对应的 60–240 步/分参考。默认选择使变速倍率的绝对对数最小的参考，平局优先原拍。
- 例如 82.5 BPM 可按每拍两步对应 165 步/分，此时变速倍率为 1。
- 支持用户手动校正 30–480 BPM。静音、稳定纯音、短音频及弱节奏材料显示无法可靠判断，并允许手动输入。
- 变速倍率等于目标步频除以所选参考步频。FFmpeg atempo 以每级 0.5–2 的链进行变速保调。新时长与波形以实际输出音频为准。
- 每次生成独立素材。再次适配时从最初音源计算总倍率，以减少重复处理造成的音质损耗。派生曲目的物理 BPM 等于当前 BPM 乘本次倍率。

## 数据与 API

Track 新增 tempo 与 adaptation，可读取缺少这些字段的历史 metadata。

tempo 为 {bpm, confidence, status, source}。bpm 可空，confidence 为 0..1 的周期性参考分数。status 为 pending、detected、uncertain 或 unavailable，source 为 analysis、manual 或 adapted。

adaptation 可空，否则为 {original_id, speed, reference_cadence, target_cadence}。original_id 指向最初素材，speed 为相对最初音源的总倍率，reference_cadence 为本次采用的参考。

- GET /api/tracks/{id} 返回单条 Track。
- POST /api/tracks/{id}/analyze 分析历史 pending 素材并返回 Track，已分析结果可复用。
- PATCH /api/tracks/{id}/tempo 接受 {bpm}，保存手动 BPM 并返回 Track。
- POST /api/tracks/{id}/adapt 接受 {cadence,reference_cadence}，返回新 Track。cadence 范围为 60..240，reference_cadence 必须对应源 BPM 的半拍、原拍或双拍，且位于同一范围。

元数据更新使用同步锁与唯一临时文件进行原子替换。分析并发应有上限，变速生成失败应清理不完整新素材。已有编排与导出参数按既有快照流程处理。

## 界面

每条曲目显示 BPM、步频参考、手动校正入口与“制作适配版”按钮。可选择半拍/原拍/双拍参考，目标默认为页面所选步频。变速成功后替换选中的编排项，显示倍率和新时长，并提供恢复原版入口。处理期间显示状态与错误反馈。

编排项使用独立实例 ID，以确保重复使用同一素材、处理期间重排或删除时，异步结果只应用到对应条目。兼容现有 localStorage 中仅记录素材 ID 的项目。历史 pending 素材通过分析入口补齐节奏信息。

## 分工与验证

1. 后端实现检测、兼容元数据、手动 BPM、变速保调与 API，增加针对实际回归风险的测试。
2. 前端实现行内节奏控件、稳定编排实例、历史素材分析与适配/恢复交互。
3. 独立审阅算法边界、兼容性、异步状态与失败回滚。
4. 运行完整 Python/前端测试、生产构建及浏览器验收。检查合成脉冲 BPM、实际变速时长与音高、三种来源、导出以及移动端。
5. 更新使用说明和截图，将完成的版本发布到既有 GitHub 仓库。

## 资料

频谱正向变化的 onset 方法可参考 librosa 文档，变速链规则参考 FFmpeg 文档。

- https://librosa.org/doc/main/generated/librosa.onset.onset_strength.html
- https://ffmpeg.org/ffmpeg-filters.html#atempo
