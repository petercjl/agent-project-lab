# 项目实验台 · Agent Project Lab

Agent 驱动的商品项目管理应用：项目看板 + Markdown Wiki + `procli`。

页面入口：<http://127.0.0.1:4317>

## 已实现

- 商品项目可用默认生命周期或 Agent 提供的自定义 SOP 初始化；店铺项目和企业项目标记为 TODO。
- 项目目录支持整体折叠和分组折叠、显式创建、共享目录归档、项目右键移动/置顶/删除，以及通过拖拽自定义目录和项目顺序。
- 项目首页支持卡片/列表视图，展示项目图片、创建时间、最新更新时间和任务完成进度。
- 项目名称唯一校验；管理员精确确认后软删除，普通员工可见删除入口但只能联系管理员。
- 可编辑任务依赖、循环检测、前置完成门槛、提交审核、通过、退回、阻塞与恢复。
- 看板顶部创建业务节点，节点内创建任务；普通成员可删除空任务或仅含空任务的节点。
- 任务内容状态分为 `empty`、`executed`、`substantive`。日期、优先级等元数据修改不影响空状态；一旦存在 Agent 运行、交付物、Agent 输出或实质 Wiki 内容，服务端禁止删除。
- Wiki 编辑与预览、关键词全文检索、正文历史版本；附件上传下载及 SHA-256 校验。
- Agent 运行登记、输入输出与质量记录；项目活动审计；审核与下游交接的本地通知。
- 人工/Agent 耗时记录及同事项平均耗时对比，人工纠正耗时计入总量。
- 项目完整 JSON 导出与新副本恢复，含任务、Wiki、附件、历史、运行与审计。
- npm 分发的 `procli`：Profile 环境路由、钉钉个人授权、结构化 JSON、dry-run、写入幂等与写后回读校验。
- 企业钉钉 OAuth 登录、Corp ID 企业边界校验、员工身份与项目成员绑定、服务端会话和个人 CLI Token。
- PostgreSQL 持久化；Markdown 与附件以普通文件保存；Docker/NAS 部署定义。

## 在这台电脑启动

```bash
cd /Users/pechen/AI/钉钉应用
npm run db
npm run build
npm start
```

终端保持运行即可。停止页面服务按 Ctrl+C；数据库继续运行，数据保留。重启页面服务再次执行 `npm start`。开发时使用 `npm run dev`。

安装依赖使用 `npm ci`。仓库内开发 CLI 可执行 `npm install -g ./packages/procli`；正式使用可从 npm 安装 `npm install -g @petercjl/procli`。已安装 PostgreSQL 17.9，独立数据库集群在 `data/postgres`，监听 `127.0.0.1:55432`，数据库名 `project_lab`。没有启动或占用 Homebrew 默认的 5432 数据库服务。

`npm run db` 只初始化专属的空目录；若目标目录存在但不是已知集群，会拒绝初始化。自定义 PostgreSQL 工具路径可设置 `PG_BIN`。本地集群使用回环地址 trust 认证，适合可信的单用户电脑；同机其他用户仍可能连接。

`.env.example` 描述可选配置。应用启动自动读取 `.env`（不存在也可运行）；已有 `.env` 应先备份再编辑，凭据文件权限建议 600。默认 `DATA_DIR=./data`、`PORT=4317`。

## 钉钉登录

产品运行默认采用企业钉钉账号登录。需要在钉钉开发者后台创建企业内部应用，添加 `Contact.User.Read` 个人权限，并登记回调地址：

```text
http://127.0.0.1:4317/api/auth/dingtalk/callback
```

复制 `.env.example` 为 `.env`，填写 Client ID、Client Secret 和本企业 Corp ID。首次启动可启用 `DINGTALK_BOOTSTRAP_FIRST_ADMIN=true`，让第一个通过企业校验的员工绑定预置主管；完成初始化后建议改为 `false`。详细步骤及安全边界见 [钉钉登录配置](docs/钉钉登录配置.md)。

浏览器登录使用服务端 OAuth 回调和 HttpOnly 会话。`procli` 为每个 Profile 单独发起钉钉授权，获得绑定当前员工身份的个人 CLI 凭证；凭证只保存在本机配置目录，不写入代码仓库或 npm 包：

```bash
procli profile add local --url http://127.0.0.1:4317 --environment development
procli auth login --profile local
procli doctor --profile local --json
```

`AUTH_MODE=development` 只用于隔离开发和自动验收；该模式允许 `x-actor` 模拟身份，不应开放给其他员工。

## 开始体验

已提供「ERM 保温杯 · 本地预演」示例：立项已完成，市场调研结构示例待审核。打开市场调研任务，浏览 Wiki 和附件，然后用主管角色审核通过，即可看到下一节点的交接消息。

示例来源是本次讨论的需求与固定 Markdown，没有读取线上 ERM 项目，也没有采集真实市场数据。示例不用于证明业务结论或提效效果。真实工作请新建项目，提供真实商品信息与研究范围。

## Agent 使用方式

`procli` 默认操作保存的 `nas` Profile。环境选择优先级为：命令行 `--profile`、环境变量 `PROCLI_PROFILE`、持久保存的当前 Profile、`nas`。开发时可持久切换到本地，也可只覆盖一条命令：

```bash
procli profile add nas --url http://<NAS地址>:14317 --environment production
procli profile add local --url http://127.0.0.1:4317 --environment development
procli profile use local
procli --profile nas doctor --json
```

商品项目默认按全生命周期模板创建，也可由 Agent 提交自定义 SOP。每个自定义节点必须同时提供 `name` 和 `description`。先预览；NAS 生产写入需明确增加 `--yes`：

```bash
procli project create --name '商品项目' --goal '明确目标' --dry-run --json
procli project create --name '商品项目' --goal '明确目标' --idempotency-key '<UUID>' --yes --json
```

自定义 SOP 与管理员软删除：

```bash
procli project create --name '验证项目' --sop-file ./sop.json --dry-run --json
procli project delete --name '验证项目' --confirm-name '验证项目' --dry-run --json
procli project delete --name '验证项目' --confirm-name '验证项目' --yes --json
```

创建成功只有在服务端回读的项目、任务数和 Wiki 数与写入响应一致时才会返回。Agent 可通过 npm 包内唯一可信源安装配套 Skill：

```bash
procli skill source --json
procli skill status --agent codex --json
procli skill install --agent codex
procli skill install --agent sealseek
```

项目实验台不内置大模型执行器。真实 Skill 在 Codex、SealSeek 或其他 Agent 宿主中运行，并通过 `procli` 操作同一套项目服务。

### 写入约定

- `--dry-run` 显示目标 Profile 与拟写请求，保持服务数据不变。
- `--idempotency-key KEY` 用于安全重试；同键同请求返回原结果，换内容或操作身份会拒绝。
- 每个 Profile 使用独立个人凭证；`procli auth status` 可核对当前身份。
- 生产环境写入必须显式 `--yes`；目标环境、实例指纹或 API 版本不匹配时拒绝写入。
- 业务写操作记录在活动中；失败调用返回稳定错误码，供 Agent 纠正输入或请求人工帮助。

## 数据与恢复

```text
data/
  postgres/                         本地 PostgreSQL 集群
  projects/<项目UUID>/
    project.yaml                    项目标识
    wiki/                           Markdown 正文
    deliverables/                   上传的原始文件与交付物
    history/<页面UUID>/             旧正文
  verification/                     自动验收独立文件库
```

PostgreSQL 中 `lab_state` 的 JSONB 保存项目状态与文档元数据。页面文件是可直接读取的 Markdown；业务写入应通过产品页面或已发布的 `procli` 能力完成，以维持版本和审计。

每次 Wiki 写入保留旧正文。常规请求失败时回滚本次文件变更与数据库事务；进程崩溃或断电时，文件系统与 PostgreSQL 之间不具备跨存储原子事务，因此重要数据应定期备份。初稿的单行 JSONB 行锁适用于小规模本地预演，大规模多人部署需进一步拆表与优化。

页面与服务端 API 已支持项目导出和新副本恢复；对应 `procli` 命令将在能力清单扩展时统一发布。恢复会分配新 ID并保留原项目，附件校验不匹配时拒绝恢复。迁移后以相对路径链接的 Wiki 可继续使用。

完整迁移并保留 ID：停止应用写入，用 `pg_dump` 备份 `project_lab`，同时备份 `data/projects`；在新 PostgreSQL 中恢复数据库并配置 `DATA_DIR` 指向项目文件的父目录。不要直接将运行中的 PostgreSQL 数据目录当成跨平台迁移包。

## 钉钉消息

当前自动生成本地审核和交接通知，可通过页面查看。登录阶段已经保存员工的钉钉稳定身份映射；接入工作通知后可按该映射定位接收人，并配置应用发消息权限、触发规则与发送策略。

## NAS / 容器

`Dockerfile` 与 `docker-compose.yml` 提供应用 + PostgreSQL + 持久化卷。Node 22 基础镜像来自微软官方容器仓库，以适配当前 NAS 无法直连 Docker Hub 的网络；PostgreSQL 固定使用 NAS 已有的 `17.11-bookworm` 镜像。需自行设置强 `POSTGRES_PASSWORD`，并处理 URL 中的特殊字符编码。避免与本地服务端口冲突。

```bash
docker compose up -d --build
```

UGREEN NAS 已完成实际部署。容器从代码目录外的 `runtime.env` 读取数据库与钉钉 OAuth 配置。日常开发发布：

```bash
git push origin main
./scripts/deploy-nas.sh ugreen-nas
```

脚本由 NAS 使用只读部署密钥从 GitHub 获取 `main`，只接受快进更新，重建应用并等待健康检查。默认只发布宿主回环地址端口；局域网员工预演可在 `runtime.env` 设置 `APP_BIND_IP=0.0.0.0`，并登记完全一致的钉钉回调地址。正式长期使用应再配置 HTTPS、备份策略和审计保护。详细过程见 [NAS 部署说明](deploy/README.md)。

## 验证

```bash
npm run check
npm test
npm run procli:test
npm run build
npm run verify:auth
npx tsx scripts/verify.ts
```

认证验收使用临时数据库和本地模拟钉钉上游，覆盖 OAuth state、换取令牌、员工资料、企业校验、浏览器会话、个人 CLI Token、撤销与退出。完整业务验收启动独立 4318 端口服务，使用 `project_lab_verification` 数据库和 `data/verification`；不修改日常 `project_lab` 数据。验收项目保留在独立库中供复查。浏览器截图保存在 `test-results`。

实施设计见 [实施方案](docs/实施方案.md)，本次测试结果见 [验收记录](docs/验收记录.md)。
