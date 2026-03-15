# @promptu/adapter-openclaw

OpenClaw plugin that integrates the Promptu Runtime.

## 接入方式

安装插件后，Promptu Runtime 通过三个点接管 OpenClaw：

| 接入点 | 职责 |
|--------|------|
| `registerContextEngine` | 接管 messages 组装（assemble），AI 声明的历史分流在这里生效 |
| `before_prompt_build` hook | 注入 Promptu 渲染的 system prompt |
| `registerTool` | 暴露 `promptu_load` / `promptu_status` 给 AI 使用 |

## 安装

```bash
# 链接到 OpenClaw extensions
openclaw plugins install -l ./packages/adapter-openclaw

# 或复制到全局 extensions
cp -r packages/adapter-openclaw ~/.openclaw/extensions/promptu
```

## 配置

```json5
{
  "plugins": {
    "entries": {
      "promptu": {
        "enabled": true,
        "config": {
          "projectPath": "~/my-agent",
          "entry": "main.ptu"
        }
      }
    },
    "slots": {
      "contextEngine": "promptu"
    }
  }
}
```

## AI 使用方式

AI 可以在运行时创建/修改 `.ptu` 文件，然后调用 `promptu_load` 立即激活：

```
1. 创建 ~/my-agent/search.ptu
2. 调用 promptu_load({ path: "search.ptu" })
3. 下一轮请求就按 search.ptu 的逻辑组装
```

## 命令

- `/promptu` — 查看 Runtime 状态
