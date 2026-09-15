# NAS 部署与本地开发闭环

## 发布边界

GitHub 私有仓库 `petercjl/agent-project-lab` 保存源代码与部署定义。数据库、项目正文、附件、密码和本地测试数据保留在运行环境，不进入 Git。

NAS 使用 `deploy/compose.yaml`：独立 PostgreSQL、独立持久化卷、应用健康检查和自动重启。数据库端口不发布到宿主，应用只监听 NAS 回环地址 `14317`。应用和数据库的内存上限分别为 512 MB、1 GB。现有 NAS 数据库及应用保持不变。

当前应用使用企业钉钉 OAuth 登录。`APP_BIND_IP` 控制宿主机监听地址：默认 `127.0.0.1` 仅供隧道访问；员工局域网试用设置为 `0.0.0.0`。局域网 HTTP 只用于企业内网预演，正式长期使用应配置 NAS 反向代理、HTTPS 和企业内网域名。

## 从本地发布

1. 本地完成 `npm run check`、`npm test` 和 `npm run build`，提交并推送 GitHub。
2. 用 `git ls-remote origin refs/heads/main` 对照本地提交，确认发布的是已上传的提交。
3. NAS 使用仓库专属、只读部署密钥克隆代码到 `<部署根>/repo`；不在 NAS 保存 GitHub 个人令牌。
4. 在代码目录以外的 `<部署根>/config/runtime.env` 保存数据库密码、钉钉应用凭证、Corp ID、回调地址和 Agent Token。文件权限必须为 600，更新代码时保持凭证、密码和数据卷不变。员工局域网预演所需配置如下，真实值不进入 Git：

```dotenv
APP_BIND_IP=0.0.0.0
AUTH_MODE=dingtalk
DINGTALK_CLIENT_ID=<Client ID>
DINGTALK_CLIENT_SECRET=<Client Secret>
DINGTALK_CORP_ID=<Corp ID>
DINGTALK_REDIRECT_URI=http://<NAS局域网地址>:14317/api/auth/dingtalk/callback
DINGTALK_BOOTSTRAP_FIRST_ADMIN=false
AUTH_SESSION_DAYS=7
AGENT_API_TOKEN=<独立高强度令牌>
```
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

默认回环绑定时，可在本地电脑建立隧道（本地 `14317` 须为空闲端口）：

```bash
ssh -N -L 127.0.0.1:14317:127.0.0.1:14317 <NAS的SSH别名>
```

浏览器打开 `http://127.0.0.1:14317`，Agent 使用：

```bash
projectctl doctor --url http://127.0.0.1:14317
```

员工局域网预演时，浏览器直接打开 `http://<NAS局域网地址>:14317`。该地址对应的完整 OAuth 回调必须同时登记在钉钉内部应用安全配置中。

验收包括：创建项目、Wiki 保存、附件下载、任务提交与审核、通知、导出恢复、重启后数据保留。NAS 验收完成后，记录提交 ID、部署目录、镜像标识和访问方式。

## 更新与回退

更新前先备份数据库和项目文件，尤其是存在数据结构变更时。用全新的提交目录重复部署命令，保持配置路径和 Compose 项目名不变。代码回退使用上一提交目录重新构建启动；只有确认数据结构兼容时，才能将旧代码连接现有数据库。

不要使用 `docker compose down -v`，该选项会删除持久化数据卷。任何需要恢复或替换数据库的操作，应先确认具体备份和目标。

## 当前实测状态

GitHub 私有仓库、NAS 只读部署密钥、代码克隆、镜像构建、独立 PostgreSQL、持久化卷、健康检查、SSH 隧道和项目导出恢复均已验证。NAS 运行目录为 `/volume1/docker/agent-project-lab`，应用监听地址由 `APP_BIND_IP` 控制。`peter` 已配置免密 sudo；现有持久化数据卷在日常发布中保持不变。
