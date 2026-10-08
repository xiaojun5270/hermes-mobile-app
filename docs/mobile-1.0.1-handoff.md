# Hermes Mobile 1.0.1

## 范围与边界

- 源码仅在 `hermes-mobile-app` 的 `feat/file-attachments`，基点
  `231253d49631d3e8f293812f91b329e19696392e`，保留 SDK57 上游。
- 版本 `1.0.1`，iOS build `2`，bundle ID
  `com.dintinoconte.hermesmobile` 不变。
- 文件使用 SDK57 系统 DocumentPicker，支持多选；最多 8 个、单个 10 MB、
  合计 25 MB 是手机端内存预算，不是服务端容量承诺。私有 Documents 复制，
  `file.attach` 传 `data_url` 与原名，提交仅引用返回的 `ref_text`。
- 本地 FIFO 可取消、恢复草稿和重试；网关队首不能撤回。每次最多交付一条，
  `queued:true`，照片只在确认空闲后交付。拒绝保留草稿，不生成成功气泡。
- Stop 先等待当前发送结束、持久保存本地暂停，再 `session.interrupt`；
  轮询不能发送暂停队尾，用户通过“继续队列”恢复。空队列普通聊天不轮询。
- Steer 仅 `session.steer` 纯文本，不 interrupt、不 redirect、不偷偷 submit。
  `queued` 仅表示接受，不能声称已经消费。

## 未知结果与持久化

当前 generated contract 的 queued/inflight/corrections 没有本次请求或用户行的唯一身份。
同文快照和历史都不能证明未知 ACK，保守保留草稿/队列和附件、显示未知状态、
禁止自动重发或冒充成功。seed 只观察，不越过发送操作改动草稿。
纯文件上传未知、尚未提交的队列项允许显式撤销/恢复；图片上传未知不能安全撤销。
真实 RPC 接受回执必须先持久化，再调用气泡回调、释放文件；存储失败不删资源，
有实际回执的重试只补落盘，不再发送。任何带 `acceptedStatus` 的队列项都不可
恢复/编辑/取消；直发回执未落盘时原草稿文字、文件和照片同样锁定，补保存只结算原内容，
不能把旧回执用于新草稿，也不清空另一条未发送草稿。

会话 journal 隔离 gateway、身份、profile 和 session。保存采用双槽协议：
完整记录含版本、完整 scope、递增 revision 与 `commit:complete`，先写并读回检查
非最新槽的临时文件，再移动到该槽，始终保留另一份最新有效记录。Expo 的
overwrite-move 会先删目标，因此不声称原子替换或 fsync 持久性保证。
启动检查两个槽、各自临时文件以及旧 `.json/.tmp`，从完整有效记录选最高 revision；
完整临时文件也可恢复，只有全部候选确实不存在才当作空会话。发现损坏或身份/版本不匹配
时不导入错误数据；有有效旧记录则保留并暂停，可能已交付的 pending 改为 unknown，
无有效记录则报错且禁止覆盖。真实磁盘 fixture 覆盖先删目标再 move 失败、
完整/半写中断、最新损坏回退、scope/version/revision/commit 不匹配与旧临时文件恢复。

## 验收与打包

验收命令：

```sh
npx tsc --noEmit --incremental false && npx jest --runInBand && npm run lint
npx expo export --platform ios --output-dir .expo/verification/ios-export
```

`chat-workflows.test.ts` 使用真实 ChatScreen、createChatTransport、上游 fakeSocket
与 RNTL，覆盖文件-only 多附件、失败重试、取消/超限、FIFO、Stop/继续、Steer、
interim/tool/final 及切会话未知 ACK 恢复。`chat-outbox.test.ts` 覆盖操作在途 seed、
陈旧同文快照、存储失败的回执/附件顺序。

`.github/workflows/build-unsigned-ipa.yml` 支持本分支 push 和 dispatch，
macOS26、读取 RN Pods 的最低 Xcode 版本并检查、npm ci、类型/测试/lint、
Expo iOS prebuild、iphoneos Release 禁用签名、Info.plist 三字段核对、
标准 Payload/*.app ZIP IPA、SHA256 与 14 天 artifacts，失败也上传诊断日志。

本机只有 Command Line Tools，不能证明 native iOS 构建或生成 IPA；
Expo export 只验证 JS/资源导出。Actions 尚未运行，需 Hermes 独立验收后
提交并 push 本功能分支触发。writer 不 commit/push/merge/deploy，不触碰生产 gateway。
旧 SDK56 stash/快照仅供恢复，不覆盖 SDK57。
