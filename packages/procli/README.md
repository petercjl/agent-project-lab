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

配置和每个 Profile 的个人凭证保存在用户配置目录，不进入 npm 包或项目仓库。运行 `procli doctor --json` 查看当前 Profile、服务指纹和认证状态。
