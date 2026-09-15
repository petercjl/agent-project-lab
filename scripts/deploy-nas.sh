#!/bin/bash
set -euo pipefail

nas_target="${1:-ugreen-nas}"
remote_root="${NAS_PROJECT_ROOT:-/volume1/docker/agent-project-lab}"

ssh -o BatchMode=yes "$nas_target" bash -s -- "$remote_root" <<'REMOTE'
set -euo pipefail
remote_root="$1"
repo="$remote_root/repo"
runtime_env="$remote_root/config/runtime.env"
deploy_key="$remote_root/config/github_deploy_key"
known_hosts="$remote_root/config/github_known_hosts"

for required in "$repo/.git" "$runtime_env" "$deploy_key" "$known_hosts"; do
  if [ ! -e "$required" ]; then
    echo "缺少 NAS 部署文件：$required" >&2
    exit 1
  fi
done

export GIT_SSH_COMMAND="ssh -i $deploy_key -o IdentitiesOnly=yes -o UserKnownHostsFile=$known_hosts -o StrictHostKeyChecking=yes"
git -C "$repo" fetch origin main
git -C "$repo" checkout main
git -C "$repo" merge --ff-only origin/main
commit="$(git -C "$repo" rev-parse HEAD)"
export APP_COMMIT="$commit"

sudo -n env APP_COMMIT="$commit" docker compose --env-file "$runtime_env" -f "$repo/deploy/compose.yaml" up -d --build

for attempt in $(seq 1 30); do
  container_health="$(sudo -n docker inspect agent-project-lab-app-1 --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || true)"
  if [ "$container_health" = healthy ] && curl -fsS http://127.0.0.1:14317/api/health >/dev/null; then
    printf 'NAS deployment healthy: commit=%s url=http://127.0.0.1:14317\n' "$commit"
    sudo -n docker compose --env-file "$runtime_env" -f "$repo/deploy/compose.yaml" ps
    exit 0
  fi
  sleep 2
done

sudo -n docker compose --env-file "$runtime_env" -f "$repo/deploy/compose.yaml" ps >&2
sudo -n docker logs --tail 100 agent-project-lab-app-1 >&2
exit 1
REMOTE
