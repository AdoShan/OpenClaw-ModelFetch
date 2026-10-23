# 配置参考

[English](../en/configuration.md) | 中文 | [返回 README](../../README-CN.md)

本文说明筛选、配置写入、Agent 同步和 `model_fetch` 工具。安装与基础使用请先阅读 [README](../../README-CN.md)。

## Provider 前提

Provider 必须已经配置在 `models.providers.<providerId>` 下，并具有有效的 `baseUrl`。Provider 的认证信息可以来自：

- OpenClaw Provider 配置中的 `apiKey`。
- Provider 配置引用的环境变量。
- OpenClaw 为 Provider 使用的认证存储。

Ollama 不需要 API Key。使用本机或私有网络地址时，还需在 Provider 配置中允许私有网络请求。

## 筛选策略

每个 Provider 都拥有独立保存的筛选策略。

| 字段 | 必填 | 行为 |
| --- | --- | --- |
| `includeRegex` | 否 | 选择模型 ID 匹配 JavaScript 正则的模型。留空表示不按正则限制。 |
| `excludeRegex` | 否 | 从正则选择结果中排除匹配的模型 ID。 |
| `manualIds` | 否 | 精确匹配的手动白名单模型 ID。 |
| `replace` | 否 | 删除 Provider 中不在最终选择内的已有模型。默认值为 `true`。 |

选择顺序如下：

1. 编译 `includeRegex` 和 `excludeRegex`。非法表达式会阻止保存和应用。
2. 如果 `manualIds` 非空且 `includeRegex` 为空，只选择白名单中的模型 ID。
3. 否则，选择匹配 `includeRegex` 且不匹配 `excludeRegex` 的模型。
4. 加入所有手动白名单 ID，即使它们匹配 `excludeRegex`。
5. 手动选择的模型如果仍存在于配置中，即使远端接口不再返回它，也会保留。

设置界面始终使用替换模式。Agent 工具可以显式传入 `replace: false` 执行追加写入；省略该参数时，实际默认值仍为 `true`。

正则输入框失焦或按下 Enter 后更新筛选结果。

## 保存的策略

设置界面将策略保存在插件配置中：

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
              },
              "targetAgents": ["main"]
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

`targetAgents` 和每个 Provider 的 `filter` 独立保存。

## 应用策略

应用策略时会执行以下步骤：

1. 重新获取 Provider 当前的远端模型列表。
2. 再次应用该 Provider 已保存的策略，并重新计算新增、删除和受保护模型。
3. 如果会删除已有模型，要求用户确认。弹窗会逐项列出模型 ID。
4. 如果远端列表、已保存策略、Provider 模型或引用保护结果在预览后发生变化，取消写入。
5. 将确认后的模型列表写入 `models.providers.<providerId>.models`。
6. 同步适用的 Agent 模型 allowlist。
7. 清除受影响会话中的过期模型选择；已锁定模型选择的会话不会修改。

如果模型 ID 已经存在，会保留原有的名称、价格、推理能力、输入模态、上下文窗口和最大 Token 等定义。

### 引用保护

替换模式不会删除仍被非 Agent 模型消费方引用的模型。例如：

- Agent 的 utility、decision、image、media、voice、PDF 和嵌入式 Agent failover 模型。
- `hooks.gmail.model` 等 Hook 默认模型。
- `hooks.mappings[].model` 等 Hook 映射模型。

删除确认弹窗会列出受保护的模型，以及保留该模型的准确配置路径。

### Agent allowlist

只要 `agents.defaults.modelPolicy.allow` 非空，就会同步默认 Agent 的 allowlist：加入本次选中的模型引用，并移除该 Provider 下已取消选择的精确引用。

对于 `agents.entries.<agentId>.modelPolicy.allow`，设置界面可以显式保存目标 Agent。勾选的 Agent 即使当前 allowlist 没有 Provider 规则也会同步；未勾选但存在匹配 Provider 规则的 Agent 条目仍可能自动同步。

同步 Agent 条目时，插件会加入本次选中的 `provider/model` 引用，并移除该 Provider 下已取消选择的精确引用。其他 Provider 和通配规则不会受影响。

应用结果包含 `targetAgents`、`syncedAgents`、`sessionSelectionResets` 和 `resetSessionKeys`。

## Agent 工具

插件提供 `model_fetch` 工具。

| 参数 | 必填 | 行为 |
| --- | --- | --- |
| `provider` | 是 | `models.providers` 下的 Provider ID。只使用该 Provider 已保存的策略。 |
| `includeRegex` | 否 | 本次调用临时覆盖已保存的包含正则。 |
| `excludeRegex` | 否 | 本次调用临时覆盖已保存的排除正则。 |
| `manualIds` | 否 | 本次调用临时覆盖已保存的精确白名单。 |
| `replace` | 否 | 删除未选中的已有模型。默认值为 `true`。 |
| `dryRun` | 否 | 只计算结果，不写入配置。 |

使用已保存策略刷新：

```json
{
  "provider": "openrouter"
}
```

使用临时策略预览，不写入配置：

```json
{
  "provider": "openrouter",
  "includeRegex": "anthropic/",
  "excludeRegex": "(embed|rerank)",
  "manualIds": ["anthropic/claude-sonnet-4"],
  "dryRun": true
}
```

返回结果包含：

| 字段 | 含义 |
| --- | --- |
| `provider` | 本次操作使用的 Provider ID。 |
| `fetched` | 远端返回的模型数量。 |
| `selected` | 最终选择的模型 ID。 |
| `protectedModels` | 因引用保护而保留的模型及配置路径。 |
| `added` | 新加入配置的模型数量。 |
| `unchanged` | 原样保留的已有模型数量。 |
| `removed` | 从配置中删除的模型数量。 |
| `replace` | 是否使用替换模式。 |
| `dryRun` | 是否未修改配置。 |
| `configPath` | 本次操作涉及的配置文件。 |
| `persisted` | 是否已经写入。 |

Agent 工具不会显示交互式删除确认弹窗。执行破坏性调用前，如果尚未在设置界面确认选择结果，应先用 `dryRun: true` 预览。

## Provider 示例

### OpenRouter

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

### Ollama

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

插件还支持 OpenAI 兼容和 Anthropic 兼容的 Provider 配置。具体 `api` 值应与当前安装的 OpenClaw 版本中的 Provider 配置保持一致。

## 相关链接

- [问题反馈](https://github.com/AdoShan/OpenClaw-ModelFetch/issues)
- [版本发布](https://github.com/AdoShan/OpenClaw-ModelFetch/releases)
- [npm 包](https://www.npmjs.com/package/openclaw-plugin-model-fetch)
