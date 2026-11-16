# StrideMix 分层音乐界面与动态背景

## 用户要求

放大字体和控件，改善可读性。参考音乐软件建立分层页面，点击功能入口进入对应界面。提供多种背景及动态效果。用户明确要求深色和浅色界面均可自选。

## 页面结构

采用 hash 路由，以便本地服务刷新、浏览器前进后退和直接进入子页面。导航变化保留项目、当前播放和导出任务。

- #/library 曲库，展示本地素材、按名称或来源搜索、加入编排。
- #/import 添加音乐，包含本地文件、视频链接、歌名搜索、AI 配乐。
- #/mix 配乐编排，展示曲目顺序、时长、节奏与起拍摘要、调试入口、间隙与整体概览。
- #/rhythm 节奏与混音，设置步频、音色及两轨音量，可返回编排。
- #/track/{entryId} 单曲调试，复用现有 BPM 校正、适配版本与逐曲相位控件，操作绑定稳定编排实例。
- #/export 导出中心，核对当前参数、选择格式、显示导出任务及其实际参数、取消与下载。
- #/appearance 背景与外观，选择深浅界面、背景、动态效果和舒适／大字号。

桌面使用侧边导航、页面标题与面包屑、固定底部播放器。手机侧栏通过导航按钮展开。已有项目优先进入编排，空项目进入曲库。

## 视觉与可读性

主体正文约 17px，必要辅助文字至少 14px。主标题约 32px，数字与常用按钮放大，交互目标至少 44px。保留清晰的焦点、表单标签、状态和错误提示。深浅两套颜色使用语义变量，检查文字对比。

背景提供晨雾山林、极光、雨夜城市、纯色。山林和城市使用原创生成场景，本地资源随仓库提供。薄雾、光带、雨线使用轻量 CSS 动画，支持关闭动态、系统减少动态效果和页面隐藏时暂停。前景使用有足够遮罩的面板承载内容。

## 实现分工与文件边界

1. 页面代理拥有 App.tsx、routing.ts、应用导航与视图模块，复用现有音频状态、操作和控件。保持 api/project/audio 等核心逻辑接口。可提取既有控件，避免重复状态。
2. 视觉代理拥有 style.css 与 Appearance.tsx，实现两套主题、字体、响应式、背景与设置页。
3. 主代理负责背景素材、README、独立浏览器验证与发布。后端与音频算法沿用当前实现。

共享外观模块 API 为 useAppearance() 返回 {appearance, updateAppearance}。appearance 为 {colorMode:'dark'|'light',scene:'forest'|'aurora'|'rain'|'plain',motion:boolean,textSize:'comfortable'|'large'}。Wallpaper 接受 settings，AppearancePage 接受 settings 与 onChange(partial)。持久化使用 stridemix.appearance.v1。

App 顶层使用 .studio-shell、data-theme 和 data-text-size。主体布局为 .sidebar、.workspace-main、.workspace-header、.page-content。通用控件采用 .primary-button、.secondary-button、.icon-button、.glass-panel、.section-heading、.empty-state。播放器沿用 .transport 等语义类。视觉代理可在页面代理输出后据实际 DOM 补齐样式。

## 验证与发布

- 检查每个路由具有独立内容，前进后退与刷新可用。
- 验证页面切换和外观设置过程中音频继续，单曲调试仍针对正确实例。
- 通过正常入口完成导入、曲库搜索与加入、排序、BPM／相位、节奏设置、导出取消和下载。
- 检查深浅界面、四个背景、动态开关、字号保存、1440px 桌面与 390px 手机，以及关键文字实际字号和横向溢出。
- 运行相关前端测试与生产构建，保留已有音频回归。
- 更新实际界面截图和使用说明，将完成版本发布到既有 GitHub 主分支并更新本地服务。

设计参考使用 Spotify 的曲库、导航及播放器分工，以及 Wallpaper Engine 的可选动态场景和暂停方式。

- [Spotify 桌面设计](https://newsroom.spotify.com/2023-06-20/spotify-desktop-experience-redesign-your-library-now-playing-views-customize/)
- [Wallpaper Engine](https://store.steampowered.com/app/431960/Wallpaper_Engine/)

## 原创背景素材

两张场景使用内置 image_gen 工具生成并保存在 frontend/public/backgrounds，生成原图同时保留在 Codex generated_images 目录。

forest.png 的提示词描述了晨曦下的常绿山谷、层叠松林、静湖、薄雾、石板蓝和森林绿，以及适合半透明界面的低对比摄影构图。原始完整提示词为

> Use case: photorealistic-natural. Asset type: original landscape background for a running-music desktop app with animated fog layers added later in CSS. Create a cinematic wide 16:9 photograph of a misty evergreen mountain valley at early dawn, layered pine forest canopies, a quiet lake reflecting pale sky, natural slate blue and forest green, soft silver mist between tree ridges, subtle warm light on the distant horizon. Peaceful immersive atmosphere, realistic fine photographic texture, elegant subdued contrast, plenty of calm detail so translucent app panels remain readable over it. Landscape fills the entire frame. No people, typography, UI, logos, borders, or watermarks. Original scene.

rain-city.png 的提示词描述了雨夜河滨步道、暖色窗灯、青蓝色建筑灯光、湿路面倒影和薄雾。原始完整提示词为

> Use case: photorealistic-natural. Asset type: original widescreen scenic background for a music app with gentle animated rain added later in CSS. A cinematic 16:9 nighttime photograph of a quiet rain-soaked urban riverside promenade, modern city buildings in the distance with warm amber window grids, a few soft cyan and blue architectural lights, wet pavement reflecting the lights, subtle mist over the river. Beautiful atmospheric depth, refined realistic photography, subdued dark navy, steel blue and copper palette, no strong central spotlight, calm background detail suitable beneath readable translucent UI panels. Natural rain atmosphere, no people, no cars in the foreground, no billboards, no signs or visible text, no logos, no UI, no border, no watermark. Original scene.

## 验收记录

85 项后端测试与 35 项前端测试通过，TypeScript 与 Vite 生产构建通过。真实 Chromium 已完成本地导入、曲库搜索和重复加入、排序移除、BPM 校正、适配与恢复、相位校正、路由刷新和前进后退、六音色试听、独立音量与跨页静音恢复。切页、切主题和换背景时播放器共用原有音频引擎，制作适配版期间返回详情仍显示任务状态。

七个页面在 1440px 和 390px、深浅主题及两档字号下无横向溢出，舒适档的主要辅助文字实际字号至少 14px。已检查四个场景、偏好保存、系统减少动态，以及页面隐藏时动画暂停。实际 WAV 下载时长为 35.4 秒，与测试编排一致。

取消真实 MP3 导出时发现 Windows 日志共享锁会覆盖取消异常，必要修复位于 backend/audio.py，改用文件型 TemporaryFile 并先等待和关闭 FFmpeg 句柄。新增实际 FFmpeg 混音阶段取消回归，修复后连续三次通过界面取消，任务均进入 cancelled 终态。
