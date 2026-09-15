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
