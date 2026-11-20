# dsh-repo-watch（仓库守望）· 产品规格 v0.1

> 状态：待评审。评审通过后再写代码。
> 一句话：**DSH 里的常驻守望——谁在等你、你的仓库有什么动静，有事才说一句。**

## 0. 为什么是这个形态

| 现有方案 | 形态 | 用户要做什么 | 缺口 |
|---|---|---|---|
| `octobox` (4.5k★) | Web 应用 | 主动打开网页 | 要记得去看 |
| `devhub` (10k★) | 桌面/移动 App | 主动打开 | 要记得去看 |
| `tj/triage` (409★) | CLI | 主动跑命令 | 要记得去跑 |
| `dinghy` (199★) | CLI 生成 HTML | 主动跑 + 打开文件 | 要记得去跑 |
| `mcollina/mcp-github-notifications` (16★) | MCP | 在 AI 客户端里问 | 纯 CRUD，没有判断 |
| **本项目** | **DSH 宿主插件** | **什么都不做** | —— |

差别只有一句：**别人是"你去查"，我们是"它来找你"**。而这恰好是 DSH 宿主插件擅长、MCP 做不好的事（常驻定时器 + 本地状态 + 已有 IM 通道）。

## 1. 定位与边界

**做**：常驻轮询 → 判断是否真的需要人 → 只在需要时通过已配置的通道推一条。

**不做**：

- ❌ 不修改 GitHub 上的已读状态（对照 `tj/triage`：查看不应等于已读）；
- ❌ 不自动回复、不自动关闭 issue（人工决定）；
- ❌ 不做 Web UI（DSH 会话就是 UI）；
- ❌ 不依赖 GitHub 的 `watch` 功能（对照 `devhub`：watcher 独立于 watch，避免通知被订阅搞乱）。

## 2. 状态机（照 Octobox 的核心洞察）

GitHub 的已读标志不可用——打开页面即标记已读，信息永久丢失。所以**自己维护状态**，只写本地：

```
        ┌──────────────── 有新活动 ────────────────┐
        ↓                                          │
   [pending] ──我看过了──> [seen] ──我处理完──> [done]
        ↑                                          │
        └──────────── 有新活动（重新浮现）──────────┘
```

| 状态 | 含义 | 会不会推 |
|---|---|---|
| `pending` | 需要我动手 | **进入时推一次** |
| `seen` | 知道但没处理 | 静默 |
| `done` | 处理完了（仅本地标记） | 静默；**有新活动则回到 `pending` 并再推一次** |

**推送只认两种转换**：`* → pending`（新进入或重开）。其余一律静默。

这条规则是整个产品的降噪核心：**没有新转换 = 一条消息都不发**。

## 3. `pending` 的判定公式

一个 thread 进入 `pending`，当且仅当满足任一：

| # | 条件 | 说明 |
|---|---|---|
| P1 | 该 thread 是我**创建**的（issue 或 PR），且**最后一条有效发言不是我自己** | 最典型的"有人在等我" |
| P2 | 任意 thread 的最后一条发言里 **@了我** | 明确点名 |
| P3 | 我的仓库里出现**外部人员新建**的 issue / PR | 有人来报告问题 |
| P4 | 我被请求 review（`review_requested`） | 阻塞别人 |

「有效发言」= 普通 comment、review、或 review comment；**排除**：bot 账号（`[bot]` 后缀 / `dependabot` / `github-actions`）、纯状态变更、我们自己的回复。

**不进入 `pending`**（避免噪音）：

- 我自己开的 issue 里只有我自己在说话；
- 别人在我的 issue 里互相讨论、且没 @我（→ 归 `quiet`）；
- 机器人评论、CI 状态变化、标签增删。

## 4. 数据源与 API 预算

| 源 | 用途 | 请求 |
|---|---|---|
| `GET /notifications?all=true&since=<watermark>` | 精确命中 mention / comment / author / review_requested | 1 次/轮 |
| `GET /repos/:owner/:repo/issues?state=all&since=<watermark>` | 外部新 issue/PR、我的仓库动静 | 每仓 1 次/轮 |

**预算**：6 个仓库 + 通知 = 7 次/轮，15 分钟一轮 → **每小时 28 次**，远低于认证上限 5000/小时。

**硬限制（必须承认）**：通知接口只给 **7 天、最多 300 条**（devhub 因此把全量历史做成付费功能）。所以：

- 本地必须留历史，否则停跑一周就永久丢失；
- 首次运行做一次「回填」：把当前未读 + 最近 30 天的 issue/PR 拉一遍，建立初始水位。

## 5. 存储

`~/.dsh/repo-watch.json`（0600）：

```json
{
  "version": 1,
  "watermark": 1795133083980,
  "threads": {
    "hAcKlyc/MyAgents#646": {
      "state": "pending",
      "kind": "issue",
      "title": "[Bug] 非 Anthropic 模型…",
      "author": "Poy-Coder",
      "lastActor": "hAcKlyc",
      "lastCommentId": 2501234567,
      "lastActivityAt": 1792078000000,
      "stateSince": 1795133083980,
      "notifiedAt": 1795133083980,
      "notifyCount": 1,
      "snoozeUntil": 0
    }
  }
}
```

**清理**：`done` 且 90 天无活动 → 删除；`threads` 上限 2000 条，超出按 `lastActivityAt` 淘汰。

## 6. 推送与抑制

| 级别 | 内容 | 规则 |
|---|---|---|
| **P0** | `waiting`（谁在等我） | 立即推，单条；**每小时最多 1 条**，多条合并成一条 |
| **P1** | `quiet`（仓库动静） | **每天最多 1 条**，且仅当有内容 |
| **P2** | `deep`（深度报告） | 从不主动推 |

抑制：

1. 同一 thread 30 分钟内不重复推；
2. 静默时段 23:00–08:00 只入队，早上合并；
3. `notifyCount` 超过 3 次的 thread 降级为「折叠进摘要」，不再单条提醒（防止长期未处理项反复骚扰）。

## 7. 配置（`Config`）

```yaml
- id: repo-watch
  name: dsh-repo-watch
  config:
    repos: []                  # 空 = 自动发现：当前 token 名下所有非 fork 仓库
    pollMinutes: 15            # 轮询间隔
    notify: true               # 总开关
    pushChannel: auto          # auto = 复用已就绪的飞书/微信通道；off = 只写本地
    quietHours: "23-8"         # 静默时段
    maxP0PerHour: 1
    maxP1PerDay: 1
    muteBots: true
    snoozeDefaultHours: 0
    tokenEnv: GITHUB_TOKEN     # 凭据引用（DSH credentials refs）
```

凭据：优先 DSH credentials 的 `GITHUB_TOKEN`，其次进程环境 `GH_TOKEN` / `GITHUB_TOKEN`。**不落盘、不打印。**

## 8. 工具面

| 工具 | 作用 |
|---|---|
| `repo_watch_status` | 状态机快照：pending / seen / done 各几条，最近一轮什么时候跑的、有没有报错 |
| `repo_watch_digest` | 生成摘要：`{ kind: "waiting" \| "quiet" \| "deep", since?, repos? }`；`deep` 带分类、优先级、相似历史与建议动作 |
| `repo_watch_ack` | 把 thread 标记为 `seen` / `done` / `snooze<N小时>`（只写本地） |
| `repo_watch_check` | 立即跑一轮轮询（调试用） |

**没有** `comment` / `close` / `label`——v0.1 不写 GitHub。需要写操作时由用户在会话里明确要求，用现有 GitHub 工具完成。

## 9. 与其他产品的对照（做差异化的依据）

| 能力 | octobox | devhub | triage | dinghy | mcollina MCP | 本项目 |
|---|---|---|---|---|---|---|
| 主动推送 | ❌ | 限通知 | ❌ | ❌ | ❌ | ✅ |
| 独立完成状态 | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ |
| 判断"谁在等我" | 人工 | 人工 | 人工 | ❌ | ❌ | ✅ 自动 |
| 阈值抑制 | 人工 | 人工 | ❌ | ❌ | ❌ | ✅ |
| 摘要可定义 | ❌ | ✅ 列 | ❌ | ✅ | ❌ | ✅ 三种 |
| 本地留历史 | ✅ | 付费 | ❌ | ✅ | ❌ | ✅ |
| 零操作 | ❌ | ❌ | ❌ | ❌ | 部分 | ✅ |

## 10. 里程碑

**v0.1（可自用）**

- [ ] 轮询 + 水位 + 状态机
- [ ] `pending` 判定 P1–P4
- [ ] `repo_watch_status` / `repo_watch_digest`（waiting + quiet）
- [ ] 通过通道推送（复用现有飞书/微信插件）
- [ ] 首次回填 30 天

**v0.2（可发布）**

- [ ] `deep` 摘要（分类 + 优先级 + 相似历史）
- [ ] `repo_watch_ack` + 会话内快捷指令（`/watch done #646`）
- [ ] 多 token / 多账号
- [ ] README + 图标 + locale，进 awesome 列表

## 11. 未决问题

1. **多账号**：现在只有一个 GitHub token，是否需要支持组织仓库/多账号？（v0.2）
2. **`deep` 的分类怎么做**：纯规则（标签 + 关键词）还是走模型？（我倾向规则优先，模型只在 `deep` 里用，因为 P0 必须即时且零成本）
3. **推送目标**：复用飞书通道，还是独立配置一个 chat？（倾向复用 `defaultChatId`，用户不必再配一遍）
4. **是否需要"我提的 issue 被关闭/被合并"通知**：算 P1 还是 P0？（倾向 P1，除非关闭理由是 `not planned`）
