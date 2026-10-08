# Hermes Mobile 1.0.2 Build 3 交接

2026-10-08（Asia/Shanghai）。仓库 `/Users/tong/Projects/hermes-mobile-app`，
分支 `feat/file-attachments`，HEAD `5a33c94619c4e1ff4e75d850d5e7d7848ef55ab7`。
所有改动仍未提交；本轮源码编辑已停止，等待父任务独立复核和正式冻结。

## 版本与中文

- Expo SDK 57；显示名称 `Hermes 智能体`；版本 `1.0.2`，iOS buildNumber `3`。
- 原生语言 `zh_CN`；保留 bundleIdentifier `com.dintinoconte.hermesmobile`。
- 自有 UI、错误、无障碍标签和本地工具摘要中文化；任务正文、动态名称、
  代码、协议枚举、Recommended fixture 与 user/model/OAuth 原话保持原值。
- 尾项覆盖 cron、models、pair、session-row、skills、connector-row、clarify、
  REST 错误和工具上下文；MCP 测试成功显示“连接正常”，过去/当前时间显示“已到期”。
- 计划仅在保存边界转换：`每2小时` → `every 2 hours`，
  `周五17:30` → `every friday at 5:30pm`；显示中文，未支持中文格式本地拦截，
  英文仍由网关检查。任务正文不参与转换。
- AST 审计定点排除 switch case 表达式、配对输入的协议 JSON、ThemeColors 调色板，
  仍检查 case 返回值、普通 JSON、UI 占位符与模板片段；开发画廊标题已中文化。

## 根因与保留证据

- 前轮队列根因：真实 RPC 激活参数为 `session.activate(runtimeId, omit_messages, profile)`；
  accepted queued 与 streaming head 保留至 idle。本轮冻结队列逻辑，没有重新定位或扩功能。
- 交接给出的独立严格 RNTL `41/41`、probe `5/5` PASS 为前轮证据，非本轮重跑。
- `src/lib/outgoing.ts` SHA-256 前后均为
  `16c5e04da6620959967902f8f60be937e9b2025679b86f53e481220563365780`。
- 前轮全套 5 个失败 suite / 18 个失败 test 涉及旧中文断言与审计误报；
  本轮更新 UI 期望，没有删除安全断言或翻译协议 fixture。
- 批量版本替换曾误改 module-importer/camelize 的依赖 version，且锁根仍为 1.0.0。
  已恢复两依赖为原 1.0.1；锁文件仅两处根版本变为 1.0.2。
  对照 HEAD 的全部 1,182 个 node_modules 对象完全一致，并补根版本、resolved、
  integrity 回归断言，无依赖升级。

## 验证

- 父任务独立 QA5（本轮提供）：`92 suites / 1441 tests / 0 fail`，
  `tsc --incremental false`、lint 0 warnings、AST `601 entries / 0 violations`。
- 本轮定向 RED：7 suites、40 个失败；锁回归 RED：1 个失败。
  GREEN：`11 suites / 282 tests` 全通过；报告 `scratch/mobile-zh-tail-green.json`。
- 本轮 `npx tsc --noEmit --incremental false`、`npm run lint`、
  `node scripts/ui-copy-audit.cjs`、`git diff --check` 均 exit 0；28 处尾空格已清理。
- 全锁比较：`scratch/mobile-lock-comparison.json`。隔离
  `npm ci --ignore-scripts --no-audit --no-fund` exit 0，安装 1,146 个包；
  日志 `scratch/mobile-npm-ci-isolated.log`。未执行安装生命周期脚本。
- iOS export：`CI=1 npx expo export --platform ios --output-dir scratch/mobile-1.0.2-build3-ios-export`
  exit 0；生成 4.7 MB Hermes bundle 和 metadata，日志 `scratch/mobile-ios-export.log`。

## 限制与冻结边界

- 本机仅 Command Line Tools，没有完整 Xcode；export 不是 IPA，也不代表原生构建、
  签名、真机 UI 或真实网关端到端验收通过。后续 unsigned IPA 留给父任务授权的 fork CI。
- 定向连接器测试有既存 overlapping act() 控制台告警，suite 通过；未扩范围修改测试框架。
- 临时迁移脚本从 `work/` 移至 `scratch/zh-migration-work/`；
  `/scratch/` 已加入本地 `.git/info/exclude`，不进入候选文件，暂存区为空。
- 本轮没有 commit、push、merge、deploy、生产网关访问或其他项目操作。
  后续仅由父任务在独立复核、冻结哈希后授权 fork `1xiaosha` 更新 PR #2，
  CI unsigned IPA 验收后才远写；原仓库不 merge，生产不部署。
