# AGENTS.md — dsh-repo-watch

面向接手的 agent/维护者。先说结论：**这个插件的难点不在 GitHub API，而在状态机**。

## 它是什么

DSH 宿主插件（不是 bundle 补丁），后台轮询 GitHub，只在“有人在等你”时推一条报数消息。判断链：
有没有人等你（状态机）→ 什么类型（分类）→ 对方在哪个阶段（进展）→ 多急（优先级）→ 有没有相似旧案。

## 结构

| 文件 | 职责 | 注意 |
|---|---|---|
| `index.mjs` | Config、轮询、推送、4 个工具、状态写入 | 唯一会写 state 的地方 |
| `lib/triage.mjs` | 纯判定：判 pending、判通知、结案目标、状态粘性 | **无 IO**，全部可单测 |
| `lib/insight.mjs` | 纯判定：分类 / 优先级 / 进展 / 相似 / 分桶 | 同上 |
| `lib/github.mjs` | 所有 HTTP（含 `issueState` 单条复核） | 只有这里碰网络 |
| `lib/state.mjs` | 状态文件读写与剪枝 | 原子写 |
| `lib/log.mjs` | `~/.dsh/repo-watch.log`，2 MB 轮转 | **绝不抛错** |

## 必须守住的不变量

1. **用户决定过的状态不被轮询覆盖**。判定“对方最后说话的不是我”在对方再开口前一直为真；若无条件写回 `pending`，`ack done` 只活一个轮询周期（真实事故，0.4.6）。写状态前必须过 `effectivePending`。
2. **`done`/`seen` 只有更新的活动才重开**（`lastActivityAt > stateSince`）。
3. **`snooze` 是“现在别说”，不是“永远别说”**：`snoozeUntil > 0` 的条目始终属于 `waiting`，到期显示「延后已到期」。
4. **结案扫描不能用轮询水位**。水位只向前走，早于它的关闭永远看不到（真实事故，0.4.4）。用固定回看窗口 `closedLookbackHours`。
5. **别人仓库里的 thread 要单独复核**（`recheckForeignThreads`），否则已合并/已关闭的 PR 永远挂着（真实事故，0.4.7）。读不到（非 404）不等于已解决。
6. **写日志的调用不能抛错**。曾经调用一个不存在的 `logInbound`，导致推送成功却记成失败并重复发送（真实事故，0.4.2/0.4.3）。`log.mjs` 全包 try/catch，且有测试断言源码里不许出现 `logInbound(`。
7. **一次推送只说“几条 + 各自要什么”**，明细走 `查看`。
8. **没有通道时消息不能悄悄消失**：守望自己不会输出，它调某个通道的 `*_send_message`。一个通道都没装时，消息留在内存队列（上限 100，超出丢最旧并记日志），`repo_watch_status` 显示推送通道 / 排队数 / 上次推送结果，并每小时提示一次。选通道用 `pushTargetName()`，`pushTool` 为空则取第一个 `*_send_message`——**安装顺序会决定去向，所以生产环境应显式 pin**。
9. **队列不是真相，发送前必须复查**：消息能在队列里躺一整夜（静默时段、每小时上限），这期间它的 thread 完全可能已经结案。`flushQueue` 用 `partitionQueue(entries, threads)` 只发 `state === 'pending'` 的条目，其余丢弃并记 `push/dropped-settled`。不这么做就会推出「有 1 条需要你」而用户点开详情发现 0 条——2026-11-22 真实发生过（消息排队时 PR 被合并，7 小时后才发出去）。
10. **版本检查只提醒，绝不自动更新**：`lib/update.mjs` 每天最多问一次 registry，缓存在 `<DSH_HOME>/repo-watch-update.json`，任何失败都静默；`repo_watch_status` 显示 `新版本：X 可用（当前 Y）`。自动升级会在用户使用时换掉代码，而 DSH 自己的更新路径也要求显式操作——不要加自动更新。

## 怎么改才安全

- 纯逻辑写进 `lib/`，用 `node --test` 覆盖；`index.mjs` 只做编排。
- **改状态机必须跑真实一轮**：`repo_watch_check`（或重启后等一轮），再读 `~/.dsh/repo-watch.json` 确认状态真的写对。单测全绿但真实轮询写坏状态，是本项目最常见的失败模式。
- 新增配置一律给默认值并写进 README 配置表。

## 测试

```
node --test test/triage.test.mjs test/message.test.mjs test/insight.test.mjs test/log.test.mjs test/foreign.test.mjs
```

## 发布

无单独脚本，手动：`push-via-api.mjs` → `pnpm pack` → `gh release create` → `npm publish`（token 用 `.npm-token.dpapi` 解出 `NPM_TOKEN`）。
发布前跑一次 `docs-check.ps1 -Dir . -Source index.mjs,lib`。
