# OpenClaw Model Fetch

在 OpenClaw Control UI 中获取指定 Provider 的远端模型，按 Provider 独立配置包含正则、排除正则和手动白名单，再将确认后的模型列表写入 `models.providers.<providerId>.models`，供 WebUI 选用。

## 功能

- 支持 OpenAI 兼容 Provider、Anthropic 兼容 Provider、Ollama 和 OpenRouter。
- 支持“获取远端模型”和“应用策略到配置”两个独立步骤，获取操作不会修改配置。
- 每个 Provider 独立保存筛选策略，切换 Provider 不会混用正则或白名单。
- 包含正则、排除正则和手动白名单可以组合使用；手动勾选的模型不会被排除正则删除。
- 正则输入框失焦或按 Enter 后更新筛选结果，非法正则会阻止保存和应用。
- 应用策略前自动重新获取模型并生成删除清单；确认期间列表或配置发生变化时取消写入。
- 默认使用替换模式，最终配置只保留当前策略选中的远端模型和已手动选择的模型。
- 已有模型 ID 会保留原有的名称、价格、模态等扩展字段，不暴露 Provider API Key。
- 选择“覆盖 Agent”后，应用策略会同步该 Agent 的 allowlist 与模型映射：新增本次选中的模型，并移除该 Provider 下已取消选择的精确条目，避免 WebUI 继续显示过期模型。

## 环境要求

- Node.js 24.16 或更新版本
- OpenClaw `2026.10.5` 或更新版本
- 已配置至少一个 `models.providers.<providerId>`，并完成该 Provider 的认证

## 安装

在仓库目录构建并检查插件：

```bash
npm install
npm run plugin:build
npm run plugin:validate
```

从当前目录安装：

```bash
openclaw plugins install /absolute/path/to/OpenClaw-ModelFetch
```

本地开发时建议使用链接安装，修改后重新构建：

```bash
openclaw plugins install /absolute/path/to/OpenClaw-ModelFetch --link
npm run plugin:build
```

可用以下命令检查插件状态：

```bash
openclaw plugins list
openclaw plugins doctor
```

## 开启设置界面

自定义插件 UI 默认关闭。打开与 Gateway 同源的 Control UI 后，进入：

**Settings → Labs → Custom plugin UI**

开启后刷新浏览器页面，Control UI 侧边栏会出现 **Model Fetch**。如果使用已安装的本地插件但没有看到菜单，请依次确认：

1. `openclaw plugins list` 中插件已启用且没有配置错误。
2. Custom plugin UI 已开启。
3. 已经运行 `npm run plugin:build`，并刷新 Control UI。
4. Control UI 与 Gateway 同源，且使用 HTTPS 或浏览器可信的 loopback 地址。

等价的配置项是：

```json5
{
  gateway: {
    controlUi: {
      experimental: {
        customPlugins: true,
      },
    },
  },
}
```

插件不自行绘制 OpenClaw 的应用侧边栏；页面和导航由 Control UI 宿主管理。

### 常见问题：安装后看不到 Model Fetch 设置页

可按以下顺序排查：

1. 确认插件已安装并启用：

   ```bash
   openclaw plugins list
   openclaw plugins doctor
   ```

2. 确认已经重新构建并让 Gateway 读取到最新 `openclaw.plugin.json`：

   ```bash
   npm run plugin:build
   ```

3. 重启 Gateway 或刷新 Control UI 页面，再进入：

   - 设置页入口：`/settings/plugins/model-fetch?view=settings`
   - 插件页面入口：`/plugin?plugin=model-fetch&id=model-fetch`

4. 若页面可打开但无功能，请检查浏览器控制台是否有报错，并优先确认插件 session action 返回值是 JSON 兼容对象（本插件当前实现已按 JSON 兼容返回）。

## 使用流程

1. 打开 **Model Fetch**，在当前 Provider 下拉框中选择目标 Provider。
2. 点击 **获取远端模型**。这一步只读取远端模型列表，不写入配置。
3. 设置包含正则、排除正则，或勾选白名单模型。勾选只会把模型加入白名单，不会立即修改 OpenClaw 配置。
4. 在“覆盖 Agent”里勾选要同步 allowlist 的 agent（仅对已配置 modelPolicy.allow 的 agent 生效）。
5. 点击 **保存策略**，保存当前 Provider 的独立筛选配置与目标 agent。
6. 点击 **应用策略到配置**。插件会重新获取远端模型并检查配置。
7. 如果这次操作会删除已有模型，确认弹窗会逐项列出即将删除的模型。确认后才会写入。
8. 回到 OpenClaw 的 Models 页面，即可选用新写入的模型。

如果你启用了模型策略 allowlist（`agents.defaults.modelPolicy.allow` 或 `agents.entries.<agent>.modelPolicy.allow` 非空），插件在应用策略时会同步本次写入的 `provider/model`。对“覆盖 Agent”中选中的 Agent，同步会移除该 Provider 下已取消选择的精确模型条目；其他 Provider、通配规则（如 `provider/*`）和保留模型的自定义 Agent 配置不会被删除。

应用默认采用替换模式：当前 Provider 中未被策略选中的模型会被删除。若预览后远端列表、筛选策略或配置中的模型发生变化，本次写入会中止并要求重新预览。

## 筛选规则

- `includeRegex`：仅选择模型 ID 匹配该 JavaScript 正则的模型。留空时不按正则限制。
- `excludeRegex`：从正则选择结果中排除匹配的模型。
- `manualIds`：精确手动白名单。存在白名单且 `includeRegex` 为空时，只选择白名单模型。
- 手动白名单优先：白名单中的模型即使匹配排除正则，仍会被选择。
- 手动白名单中的模型如果仍存在于配置中，会继续保留，即使远端这次没有返回它。
- `replace`：插件默认使用 `true`。设置界面始终按替换模式运行；Agent 工具调用可显式传入 `false`，只增加模型而不删除旧模型。
- 非法正则不会被保存或应用。

Provider 策略保存在插件配置中：

```json
{
  "plugins": {
    "entries": {
      "model-fetch": {
        "config": {
          "providers": {
            "openrouter": {
              "filter": {
                "includeRegex": "^(openai|anthropic)/",
                "excludeRegex": "(embed|rerank)",
                "manualIds": ["openai/gpt-4o-mini"],
                "replace": true
              }
            },
            "ollama": {
              "filter": {
                "manualIds": ["qwen3:latest", "llama3.1:8b"],
                "replace": true
              }
            }
          }
        }
      }
    }
  }
}
```

## Agent 工具

工具名称为 `model_fetch`。只使用已保存策略刷新并写入配置：

```json
{
  "provider": "openrouter"
}
```

使用临时筛选做 dry run，不写配置：

```json
{
  "provider": "openrouter",
  "includeRegex": "anthropic/",
  "dryRun": true
}
```

临时手动选择模型：

```json
{
  "provider": "ollama",
  "manualIds": ["qwen3:latest", "llama3.1:8b"]
}
```

工具结果包含 Provider、远端模型数、最终选中的模型 ID、新增/未变/删除数量、配置路径以及是否已持久化。

## Provider 示例

```json
{
  "models": {
    "providers": {
      "openrouter": {
        "baseUrl": "https://openrouter.ai/api/v1",
        "api": "openai-responses",
        "models": []
      }
    }
  }
}
```

Ollama 或其他本地地址需要显式允许私有网络访问：

```json
{
  "models": {
    "providers": {
      "ollama": {
        "baseUrl": "http://127.0.0.1:11434",
        "api": "ollama",
        "request": {
          "allowPrivateNetwork": true
        },
        "models": []
      }
    }
  }
}
```

## 开发

```bash
npm test
npm run typecheck
npm run plugin:build
npm run plugin:validate
```

浏览器界面源文件是 `src/control-ui.ts` 和 `src/settings-view.ts`。`npm run plugin:build` 会生成带内容哈希的 `dist/control-ui/` 资源，并更新 `openclaw.plugin.json.controlUi`。
