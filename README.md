# 项目实验台 · Agent Project Lab

本地商品项目管理应用：项目看板 + Markdown Wiki + Agent CLI。

页面入口：<http://127.0.0.1:4317>

## 已实现

- 商品生命周期模板建项目，七阶段看板，任务增改、负责人、审核人、截止日期、优先级、验收标准。
- 可编辑任务依赖、循环检测、前置完成门槛、提交审核、通过、退回、阻塞与恢复。
- Wiki 编辑与预览、关键词全文检索、正文历史版本；附件上传下载及 SHA-256 校验。
- Agent 运行登记、输入输出与质量记录；项目活动审计；审核与下游交接的本地通知。
- 人工/Agent 耗时记录及同事项平均耗时对比，人工纠正耗时计入总量。
- 项目完整 JSON 导出与新副本恢复，含任务、Wiki、附件、历史、运行与审计。
- `projectctl` CLI，结构化 JSON、错误码、dry-run、写入幂等键、版本冲突保护。
- PostgreSQL 持久化；Markdown 与附件以普通文件保存；Docker/NAS 部署定义。

## 在这台电脑启动

```bash
cd /Users/pechen/AI/钉钉应用
npm run db
npm run build
npm start
```

终端保持运行即可。停止页面服务按 Ctrl+C；数据库继续运行，数据保留。重启页面服务再次执行 `npm start`。开发时使用 `npm run dev`。

安装依赖使用 `npm ci`，全局 CLI 链接使用 `npm link`。已安装 PostgreSQL 17.9，独立数据库集群在 `data/postgres`，监听 `127.0.0.1:55432`，数据库名 `project_lab`。没有启动或占用 Homebrew 默认的 5432 数据库服务。

`npm run db` 只初始化专属的空目录；若目标目录存在但不是已知集群，会拒绝初始化。自定义 PostgreSQL 工具路径可设置 `PG_BIN`。本地集群使用回环地址 trust 认证，适合可信的单用户电脑；同机其他用户仍可能连接。

`.env.example` 描述可选配置。应用启动自动读取 `.env`（不存在也可运行）；已有 `.env` 应先备份再编辑，凭据文件权限建议 600。默认 `DATA_DIR=./data`、`PORT=4317`。

## 开始体验

已提供「ERM 保温杯 · 本地预演」示例：立项已完成，市场调研结构示例待审核。打开市场调研任务，浏览 Wiki 和附件，然后用主管角色审核通过，即可看到下一节点的交接消息。

示例来源是本次讨论的需求与固定 Markdown，没有读取线上 ERM 项目，也没有采集真实市场数据。示例不用于证明业务结论或提效效果。真实工作请新建项目，提供真实商品信息与研究范围。

## Agent 使用方式

```bash
projectctl doctor
projectctl capabilities
projectctl --help
projectctl project list
projectctl project create --name '商品项目' --goal '明确目标' --dry-run
```

典型闭环（尖括号替换为返回的真实标识）：

```bash
projectctl project summary --id <项目ID>
projectctl task get --id <任务ID>
projectctl wiki read --project <项目ID> --path wiki/01-待立项.md
projectctl task start --id <任务ID>
projectctl run start --task <任务ID> --skill <实际执行能力名称> --skill-version <版本> --input '输入范围与依据'
# 在当前 Agent 宿主中执行具体业务能力，产出报告.md
projectctl wiki write --project <项目ID> --path <任务的wikiPath> --file 报告.md --run <运行ID>
projectctl artifact add --task <任务ID> --file 原始数据.csv
projectctl run finish --id <运行ID> --status completed --output '报告及依据已交付' --quality '说明校验结果'
projectctl task submit --id <任务ID>
# 主管人工确认后，通过界面审核，或由明确授权的 Agent 执行：
projectctl task approve --id <任务ID> --actor supervisor
```

CLI 默认角色为 `agent`。预置成员 ID：`supervisor`、`market`、`design`、`operations`、`agent`。新增实际成员用 `projectctl member add --name 姓名`，之后可在页面中分配。

项目实验台不内置大模型执行器，也不会仅因填写 Skill 名称就自动执行它。真实 Skill 在 Codex、SealSeek 或其他 Agent 宿主中运行，用 CLI 完成项目上下文读取和结果回写。自动执行应遵守原业务 Skill 的授权和验收要求。

### 写入约定

- `--dry-run` 显示拟写请求，保持服务数据不变。
- `--idempotency-key KEY` 用于安全重试；同键同请求返回原结果，换内容或操作身份会拒绝。
- `task update` 支持 `--json`，包含 `dependencies` 数组和 `stage`；默认读取当前版本，`--version N` 可严格指定预期版本。
- Wiki 更新要求版本相符，CLI 默认先读取元数据。UI 在冲突时保留编辑正文，可复制后重新载入再合并。
- 附件最大 20 MB；完整导入 JSON 最大 100 MB，包含 Base64 编码开销。更大数据集用数据库 + 文件目录备份。
- 提交的正文长度或附件存在只是软件门槛；交付质量由审核人判定。
- 业务写操作记录在活动中；失败调用返回错误码，可由 Agent 纠正输入或请求人工帮助。

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

PostgreSQL 中 `lab_state` 的 JSONB 保存项目状态与文档元数据。页面文件是可直接读取的 Markdown；建议通过 CLI 写入以维持版本和审计。直接手改文件不会自动更新元数据或生成审计记录。

每次 Wiki 写入保留旧正文。常规请求失败时回滚本次文件变更与数据库事务；进程崩溃或断电时，文件系统与 PostgreSQL 之间不具备跨存储原子事务，因此重要数据应定期备份。初稿的单行 JSONB 行锁适用于小规模本地预演，大规模多人部署需进一步拆表与优化。

```bash
projectctl project export --id <项目ID> --file 全新备份文件.json
projectctl project restore --file 全新备份文件.json
```

导出拒绝覆盖已有文件。恢复会分配新 ID，保留原项目，附件校验不匹配则拒绝恢复。迁移后以相对路径链接的 Wiki 可继续使用；正文中手工写入的绝对路径或旧项目 URL 需要另行调整。

完整迁移并保留 ID：停止应用写入，用 `pg_dump` 备份 `project_lab`，同时备份 `data/projects`；在新 PostgreSQL 中恢复数据库并配置 `DATA_DIR` 指向项目文件的父目录。不要直接将运行中的 PostgreSQL 数据目录当成跨平台迁移包。

## 钉钉消息

当前自动生成本地审核和交接通知，可通过页面与 `projectctl notification list` 查看。真实钉钉联动尚未接入；后续通过企业现有官方 `dws` 能力与消息授权流程接入，并确认接收人与发送策略。

## NAS / 容器

`Dockerfile` 与 `docker-compose.yml` 提供应用 + PostgreSQL + 持久化卷。Node 22 基础镜像来自微软官方容器仓库，以适配当前 NAS 无法直连 Docker Hub 的网络；PostgreSQL 固定使用 NAS 已有的 `17.11-bookworm` 镜像。需自行设置强 `POSTGRES_PASSWORD`，并处理 URL 中的特殊字符编码。避免与本地服务端口冲突。

```bash
docker compose up -d --build
```

UGREEN NAS 已完成实际部署。日常开发发布：

```bash
git push origin main
./scripts/deploy-nas.sh ugreen-nas
```

脚本由 NAS 使用只读部署密钥从 GitHub 获取 `main`，只接受快进更新，重建应用并等待健康检查。默认只发布宿主回环地址端口；正式开放到局域网之前应增加身份认证、访问权限、HTTPS、备份策略和审计保护。本地角色切换用于验证流程，不是安全认证，不能直接暴露到公网。详细过程见 [NAS 部署说明](deploy/README.md)。

## 验证

```bash
npm run check
npm test
npm run build
npx tsx scripts/verify.ts
```

自动验收启动独立 4318 端口服务，使用 `project_lab_verification` 数据库和 `data/verification`；不修改日常 `project_lab` 数据。验收项目保留在独立库中供复查。浏览器截图保存在 `test-results`。

实施设计见 [实施方案](docs/实施方案.md)，本次测试结果见 [验收记录](docs/验收记录.md)。
