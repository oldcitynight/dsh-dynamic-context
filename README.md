# dsh-dynamic-context · 动态上下文与单元任务图

本插件把 DeepSeek Harness 的一次任务组织成可递归展开的单元。任务图基础包持有状态和事务，动态上下文负责给当前角色装配事实与工具、选择模型、收集执行报告和安排独立审计。两包安装到同一 profile 后，输入 `/task-graph [任务说明]` 直接启动完整流程。[随包离线运行图谱](docs/UNIT_WORKFLOW_20261123.html)

**与官方 Timeline（时间线）不兼容。** 在含有 Timeline 的 DSH 中，请在「插件 → 更多 → 时间线」关闭它，再启用这一套任务图。同一 profile 同时开启两者不在支持范围内。官方从 DSH `0.2.3-alpha.1` 引入此实验插件。[官方发布说明](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.3-alpha.1)

<!-- dsh-install:start -->
<!-- Generated from package.json and DSH-COMPATIBILITY.json. -->
## 选择与 DSH 配套的构建

本包 `dsh-dynamic-context@0.1.2-rc.4` 的目标标签为 `dsh-0.2.2-alpha.2`。本线支持的 DSH 精确版本为 `0.2.2-alpha.2`。插件 Node.js 要求为 `^22.19.0 || >=24.0.0`，还须满足所选 DSH 本身的 Node.js 要求。

插件的 `latest` 跟随官方 DSH 的 `latest`，插件的 `next` 跟随官方 DSH 的 `alpha`。两个插件须使用同一行的 RC 后缀。npm 标签可移动，安装前先运行 `dsh --version`。[本构建兼容清单](DSH-COMPATIBILITY.json)

使用 Linux 或 WSL 中的 Linux 版 Node.js。原生 Windows 与 macOS 会收到 npm 的 `EBADPLATFORM`。本版工作流兼容周期为 `1`。

本维护线需要一次宿主适配。在安装 Bundle 后、启动 Web 前，将 BUNDLE_DIR 指向当前已解包的插件，DSH_NODE_MODULES 指向实际运行 DSH 的 node_modules，运行以下命令再启动或重启 DSH。

```sh
node "$BUNDLE_DIR/scripts/patch-native-presentation.mjs" "$DSH_NODE_MODULES"
```

### 安装本地候选包或已下载的 Release 附件

将对应宿主的一组 .tgz 放在当前目录。以下命令安装到 `task-context` profile。首次创建时选用未占用的名称并运行下列第一条命令，已有 profile 从安装命令开始。

```sh
dsh --profile task-context --from-default-profile web --dump-config
dsh plugin --profile task-context add "$PWD/dsh-better-task-grapth-0.3.2-rc.4.tgz"
dsh plugin --profile task-context add "$PWD/dsh-dynamic-context-0.1.2-rc.4.tgz"
dsh --profile task-context web
```

先安装任务图基础包，再安装动态上下文。初装即启用。在新会话输入 `/task-graph [任务说明]` 进入完整单元流程，普通聊天沿用 DSH 原流程。

### 从 npm 安装

下面的查询会访问公共登记库。只有两包所需版本均已公开（独立安装只需基础包）时才运行安装。若查询返回 E404，使用上一节的本地包。

```sh
npm view --registry=https://registry.npmjs.org/ dsh-better-task-grapth@0.3.2-rc.4 version && npm view --registry=https://registry.npmjs.org/ dsh-dynamic-context@0.1.2-rc.4 version &&
dsh plugin --profile task-context add dsh-better-task-grapth@0.3.2-rc.4 &&
dsh plugin --profile task-context add dsh-dynamic-context@0.1.2-rc.4
```

### 从对应版本的源码构建

在该维护线源码目录内运行下列命令。配套任务图尚未进入公共登记库时，构建动态上下文前先用 `npm cache add ./dsh-better-task-grapth-0.3.2-rc.4.tgz` 缓存同批基础包。

```sh
npm ci --prefer-offline
mkdir -p .test-tmp
TMPDIR="$PWD/.test-tmp" npm test
npm run pack:bundle
```

产物为 `dist/dsh-dynamic-context-0.1.2-rc.4.tgz`。打开包内 [HTML 运行图谱](docs/UNIT_WORKFLOW_20261123.html) 可离线查阅流程、角色原文和联动指南。
<!-- dsh-install:end -->

## 从用户目标到最终报告

首次规划从用户输入提取既有条件、目标、执行准则、验收标准和事实，建立根单元。路由者逐单元选择直接执行或展开子图。展开时先规划本层，再交独立审计。执行者提交 PASS 或 FAILED 的拟结请求。前序树支持 AND、OR、NOT，程序计算分支 BLOCK。每层的终点最后调度，且不能作为本层其他单元的前置。已审终点触发父单元拟结，根单元审结后进入最终报告。[单元协议](HIERARCHICAL-WORKFLOW.md) · [前序规则与编辑工具](PREREQUISITE-RULES.md) · [验收协议](ACCEPTANCE-PROTOCOL.md)

计划复查可以继续、发起蓝图修改并送审，或重建单元基线、审计并重新规划。无可执行单元时，在相应层诊断阻塞，可重开已审工作、调整本层或重建基线。用户在运行中可以查询资料、提出新要求、更新有版本的事实，或将输入路由给指定角色。[异常处理](BLOCKAGE-HANDLER.md) · [用户输入图](docs/UNIT_WORKFLOW_20261123.html#user)

## 运行中共享上下文

可变事实以 ID 和版本绑定单元。修改事实保留来源和历史，角色按授权的范围读取当前值及证据。一次请求的第三方预装文本合计默认 10 KiB，共享事实、历史、报告等动态材料合计默认 64 KiB。超过动态阈值时，模型收到带来源和分页指针的摘要，可用当次开放的证据读取工具调取原文。[上下文与权限协议](ROLE-EXTENSIONS.md)

## 插件设置页

在「插件 → 动态上下文」配置运行参数、角色策略、模型和 API 后端、存储及工作流偏好。默认通过 DSH 已登录的 DeepSeek 账户运行 Direct 通道。模型凭据由所选后端提供。各角色可以独立选择后端，压缩沿用触发压缩的角色后端。已签发的请求按检查点保存的装配信息恢复。[设置与默认值](docs/UNIT_WORKFLOW_20261123.html#settings)

外部 Skill 可按角色与槽位替换或追加预装正文。其他插件可在挂载期间注册同步上下文提供者、角色模型，或按 DSH 已登记工具 ID 查询当前名单模式，再登记整工具、单项操作或错误类型。同一工具多份登记由优先级处理。[离线联动适配指南](docs/UNIT_WORKFLOW_20261123.html#interop) · [可运行的配置示例](examples/role-policy.json) · [工具默认清单](ROLE-TOOL-DEFAULTS.md) · [错误转交](TOOL-ERROR-POLICY.md)

## 恢复时的插件版本

新版完整模式使用单元工作流 v2。旧版完整工作流需在新会话以原目标、事实和已有成果重建根单元。同一兼容周期允许升级，恢复后冻结当前两包的版本，后续降级会阻塞。不同兼容周期也会阻塞。版本判断读取包声明，用户自行修改版本或实现需要自行承担恢复后果。新实例按配置保存工作流数据库和证据，备份和离线核对步骤见[存储与恢复](WORKFLOW-STORAGE.md)。

## 后续开发方向

1. 将各角色的信息可见范围移入配置文件，并开放设置页与插件动态调整接口。
2. 支持原生 Windows 和 macOS。
3. 发布独立的多 Agent 推理插件，与单元任务图联动。
4. 为 Codex 和 OpenCode 的兼容接入做准备。
5. 分别为 ChatGPT 系和 Qwen 系模型编写、调优专用预装上下文。

## 许可证

GPL-3.0-only。随包列有上游派生材料的许可说明。[LICENSE](LICENSE) · [DSH 压缩说明许可](DSH-COMPACTION-LICENSE.txt)
