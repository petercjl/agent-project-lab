# NAS 部署与本地开发闭环

## 发布边界

GitHub 私有仓库 `petercjl/agent-project-lab` 保存源代码与部署定义。数据库、项目正文、附件、密码和本地测试数据保留在运行环境，不进入 Git。

NAS 使用 `deploy/compose.yaml`：独立 PostgreSQL、独立持久化卷、应用健康检查和自动重启。数据库端口不发布到宿主，应用只监听 NAS 回环地址 `14317`。应用和数据库的内存上限分别为 512 MB、1 GB。现有 NAS 数据库及应用保持不变。

当前应用使用本地角色模拟，远程试用通过 SSH 隧道访问。开放局域网或公网之前，应先实现身份认证、权限控制和 HTTPS。

## 从本地发布

1. 本地完成 `npm run check`、`npm test` 和 `npm run build`，提交并推送 GitHub。
2. 用 `git ls-remote origin refs/heads/main` 对照本地提交，确认发布的是已上传的提交。
3. NAS 使用仓库专属、只读部署密钥克隆代码到 `<部署根>/repo`；不在 NAS 保存 GitHub 个人令牌。
4. 在代码目录以外的 `<部署根>/config/runtime.env` 保存 `POSTGRES_PASSWORD`。采用随机十六进制字符串，避开连接 URL 转义问题；文件权限 600，更新代码时保持密码和数据卷不变。
5. 首次部署后，日常更新从本地仓库执行：

```bash
./scripts/deploy-nas.sh ugreen-nas
```

`agent-project-lab` 是固定 Compose 项目名，因此更新代码时使用同一组持久化卷。首次启动得到空项目库，本地预演数据可按需导出并在 NAS 恢复；代码发布不会自动携带本地数据。脚本在 NAS 执行 `fetch` 和 `merge --ff-only`，将 Git 提交 ID 写入镜像标签及健康接口，构建完成后等待容器与 HTTP 健康检查。

## 访问与验收

在 NAS 检查健康状态：

```bash
curl --fail http://127.0.0.1:14317/api/health
```

在本地电脑建立隧道（本地 `14317` 须为空闲端口）：

```bash
ssh -N -L 127.0.0.1:14317:127.0.0.1:14317 <NAS的SSH别名>
```

浏览器打开 `http://127.0.0.1:14317`，Agent 使用：

```bash
projectctl doctor --url http://127.0.0.1:14317
```

验收包括：创建项目、Wiki 保存、附件下载、任务提交与审核、通知、导出恢复、重启后数据保留。NAS 验收完成后，记录提交 ID、部署目录、镜像标识和访问方式。

## 更新与回退

更新前先备份数据库和项目文件，尤其是存在数据结构变更时。用全新的提交目录重复部署命令，保持配置路径和 Compose 项目名不变。代码回退使用上一提交目录重新构建启动；只有确认数据结构兼容时，才能将旧代码连接现有数据库。

不要使用 `docker compose down -v`，该选项会删除持久化数据卷。任何需要恢复或替换数据库的操作，应先确认具体备份和目标。

## 当前实测状态

GitHub 私有仓库、NAS 只读部署密钥、代码克隆、镜像构建、独立 PostgreSQL、持久化卷、健康检查、SSH 隧道和项目导出恢复均已验证。NAS 运行目录为 `/volume1/docker/agent-project-lab`，应用仅发布到回环地址 `127.0.0.1:14317`。`peter` 已配置免密 sudo；SSH 只增加了该回环端口的转发许可。现有容器和数据库未被修改。
