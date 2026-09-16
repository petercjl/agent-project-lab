# procli

`procli` 是自建项目管理系统面向人和 Agent 的稳定 CLI。npm 包同时分发唯一真源的 `project-management` Skill。

```bash
npm install -g @petercjl/procli@latest
procli profile add nas --url http://NAS地址:14317 --environment production
procli auth login --profile nas
procli skill install --agent codex
```

默认 Profile 是 `nas`。开发时可持久切换到本地，或只覆盖一条命令：

```bash
procli profile add local --url http://127.0.0.1:4317 --environment development
procli profile use local
procli --profile nas project create --name "NAS 测试项目" --goal "验证最终服务" --yes
```

创建生产项目支持目标确认、幂等和写后回读：

```bash
procli project create --name "新品项目" --goal "完成市场验证与上市" --yes
```

只读命令可直接查询目录、项目和任务记录：

```bash
procli directory list
procli task list --project "新品项目"
procli task get --project "新品项目" --task "完成市场与竞品调研"
```

`task get` 返回节点当前状态、状态历史、依赖、活动记录、Agent 运行、交付物、Wiki 元数据和通知。

节点是看板中的阶段列。添加节点前先读取当前节点顺序，默认追加到末尾，也可以指定前后位置：

```bash
procli node create-context --project "新品项目" --json
procli node create --project "新品项目" --name "产品定价" \
  --after-node "市场调研" --context-token "<令牌>" \
  --idempotency-key "<UUID>" --dry-run --json
```

删除节点会把节点、其中的任务、Wiki、附件和执行记录作为一个批次放入回收站。其他节点存在下游依赖时默认阻止；`detach` 必须由用户明确选择。有实质产出的节点只能由管理员删除：

```bash
procli node delete-context --project "新品项目" --node "产品定价" --json
procli node delete --project "新品项目" --node "产品定价" \
  --confirm-node "产品定价" --dependency-policy block --dry-run --json
procli node restore --deletion-id "<deletionId>" \
  --confirm-node "产品定价" --dry-run --json
```

添加任务需要先读取精简写前快照。预演和真实写入使用同一个 `contextToken` 和幂等键；如果期间网页端或其他 Agent 修改了项目，写入会返回 `PROJECT_STATE_CHANGED`：

```bash
procli task create-context --project "新品项目" --json
procli task create --project "新品项目" --node "市场调研" \
  --title "整理亚马逊热销款价格带" \
  --description "统计前20款商品的价格、销量和主要卖点" \
  --context-token "<create-context 返回的令牌>" \
  --idempotency-key "<同一逻辑尝试的 UUID>" --dry-run --json
```

本地 Profile 确认预演后移除 `--dry-run` 即可写入；生产 Profile 还需要 `--yes`。新任务默认添加到节点末尾，可使用 `--before-task`、`--after-task` 指定位置，使用 `--depends-on` 显式指定依赖。

任务删除采用可恢复链路。CLI 会读取当前状态、计算影响哈希，并把任务 Wiki、历史版本和附件移动到按 `deletionId` 隔离的回收目录。存在下游依赖时默认阻止删除，只有明确选择 `detach` 或 `rewire` 才会继续：

```bash
procli task delete-context --project "新品项目" --task "完成市场与竞品调研" --json
procli task delete --project "新品项目" --task "完成市场与竞品调研" \
  --confirm-task "完成市场与竞品调研" --dependency-policy block --dry-run --json
procli task delete --project "新品项目" --task "完成市场与竞品调研" \
  --confirm-task "完成市场与竞品调研" --dependency-policy detach \
  --idempotency-key "<UUID>" --json
```

查看回收记录并恢复任务：

```bash
procli trash list --project "新品项目" --json
procli trash get --deletion-id "<deletionId>" --json
procli task restore --deletion-id "<deletionId>" \
  --confirm-task "完成市场与竞品调研" --dry-run --json
```

恢复写入时移除 `--dry-run`；生产 Profile 还需要 `--yes`。任务默认保留 90 天，当前版本不自动彻底清除。

商品项目默认生成标准生命周期 SOP。Agent 也可以提交自定义 SOP；每个节点都必须有名称和工作说明：

```json
{
  "nodes": [{ "name": "验证需求", "description": "取得真实用户证据并形成结论" }]
}
```

```bash
procli project create --name "新品验证" --sop-file ./sop.json
```

删除项目仅允许系统管理员执行，必须先预览、精确复述项目名称并显式确认。删除是可恢复的软删除：

```bash
procli project delete --name "新品验证" --confirm-name "新品验证" --dry-run
procli project delete --name "新品验证" --confirm-name "新品验证" --yes
```

店铺项目和企业项目已保留为后续能力，目前 CLI 会返回 `FEATURE_UNSUPPORTED`。

配置和每个 Profile 的个人凭证保存在用户配置目录，不进入 npm 包或项目仓库。运行 `procli doctor --json` 查看当前 Profile、服务指纹和认证状态。
