# OpenClaw Model Fetch

[English](./README.md) | 中文

[![CI](https://github.com/AdoShan/OpenClaw-ModelFetch/actions/workflows/ci.yml/badge.svg)](https://github.com/AdoShan/OpenClaw-ModelFetch/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/openclaw-plugin-model-fetch.svg)](https://www.npmjs.com/package/openclaw-plugin-model-fetch)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

在 OpenClaw Control UI 中获取指定 Provider 的远端模型，按 Provider 筛选，并将确认后的模型写入 OpenClaw 配置，供 WebUI 选用。

## 功能

- 支持 OpenAI 兼容、Anthropic 兼容、Ollama 和 OpenRouter Provider。
- 为每个 Provider 独立保存包含正则、排除正则和手动白名单策略。
- 将获取模型与应用配置分开，并在写入前显示所有待删除模型。
- 保护仍被其他 OpenClaw 配置引用的模型，并可同步 Agent 模型 allowlist。

## 环境要求

- Node.js 24.16 或更新版本
- OpenClaw `2026.10.5` 或更新版本
- 已配置至少一个具有有效 `baseUrl` 及所需认证信息的 `models.providers.<providerId>`

## 快速开始

### 1. 安装

```bash
openclaw plugins install openclaw-plugin-model-fetch
```

### 2. 开启设置界面

自定义插件 UI 默认关闭。打开与 Gateway 同源的 Control UI，然后开启：

**Settings -> Labs -> Custom plugin UI**

也可以直接使用 OpenClaw CLI 开启：

```bash
openclaw config set gateway.controlUi.experimental.customPlugins true --strict-json
```

刷新浏览器页面后，Control UI 侧边栏会出现 **Model Fetch**。

### 3. 检查安装

```bash
openclaw plugins list
openclaw plugins doctor
```

插件应处于启用、已加载状态，并且没有配置错误。

## 使用

1. 打开 **Model Fetch**，选择目标 Provider。
2. 点击 **获取远端模型**。该操作只读取远端模型列表。
3. 设置包含正则、排除正则，或勾选模型加入手动白名单。
4. 选择需要同步模型 allowlist 的 Agent。
5. 点击 **保存策略**。
6. 点击 **应用策略到配置**。
7. 出现删除确认弹窗时逐项检查。确认前不会写入任何模型配置。
8. 打开 OpenClaw 的 Models 页面，选用新写入的模型。

设置界面会跟随 OpenClaw WebUI 的语言显示：中文区域使用中文，其他区域默认使用英文。

### 各操作的影响

| 操作 | 修改插件策略 | 修改 Provider 模型 | 需要删除确认 |
| --- | --- | --- | --- |
| 获取远端模型 | 否 | 否 | 否 |
| 保存策略 | 是 | 否 | 否 |
| 应用策略到配置 | 否 | 是 | 仅在会删除模型时 |

默认使用替换模式。应用策略时，未选中的已有 Provider 模型会被删除；仍被其他 OpenClaw 配置引用的模型会受到保护。

筛选规则、引用保护、Agent 同步、`model_fetch` 工具和 Provider 示例请阅读 [配置参考](https://github.com/AdoShan/OpenClaw-ModelFetch/blob/main/docs/zh-CN/configuration.md)。

## 故障排查

### 没有显示或启用 Model Fetch

运行 `openclaw plugins list` 和 `openclaw plugins doctor`。如果插件缺失或被判定为包损坏，请重新安装。

### 侧边栏没有 Model Fetch 入口

确认已开启 **Settings -> Labs -> Custom plugin UI**，然后刷新 Control UI。设置页直达地址是 `/settings/plugins/model-fetch?view=settings`。

### 获取远端模型失败

确认 Provider 的 `baseUrl`、`api` 和认证信息在 OpenClaw 中可以正常工作。Ollama 等本机或私有网络地址需要启用 `request.allowPrivateNetwork: true`。

### 应用后仍能看到旧模型

确认应用操作已经完成，并检查相关 Agent 是否已选择同步。部分模型可能因引用保护而被有意保留。请检查应用结果后刷新 Models 页面或受影响的会话。

## 文档与反馈

- [配置参考](https://github.com/AdoShan/OpenClaw-ModelFetch/blob/main/docs/zh-CN/configuration.md)
- [English configuration reference](https://github.com/AdoShan/OpenClaw-ModelFetch/blob/main/docs/en/configuration.md)
- [问题反馈](https://github.com/AdoShan/OpenClaw-ModelFetch/issues)
- [版本发布](https://github.com/AdoShan/OpenClaw-ModelFetch/releases)
- [npm 包](https://www.npmjs.com/package/openclaw-plugin-model-fetch)

## 开发

在源码仓库中运行：

```bash
npm ci
npm test
npm run plugin:validate
```

`plugin:validate` 会构建并校验插件。需要直接使用源码目录时，可运行 `openclaw plugins install /absolute/path/to/OpenClaw-ModelFetch --link`。源码修改后需要重新构建并重新加载插件。

## License

MIT
