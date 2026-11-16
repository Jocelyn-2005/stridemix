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
