#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
PG_BIN="${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
LAB_DB_DIR="$PWD/data/postgres"
if [ ! -x "$PG_BIN/pg_ctl" ]; then echo 'PostgreSQL 17 未找到；请安装或配置 PG_BIN'; exit 1; fi
if [ ! -f "$LAB_DB_DIR/PG_VERSION" ]; then
 if [ -e "$LAB_DB_DIR" ]; then echo "目录已存在且不是已知数据库，拒绝初始化：$LAB_DB_DIR"; exit 1; fi
 mkdir -p "$PWD/data"
 "$PG_BIN/initdb" -D "$LAB_DB_DIR" -E UTF8 --locale=en_US.UTF-8 --auth-local=trust --auth-host=trust
fi
if ! "$PG_BIN/pg_ctl" -D "$LAB_DB_DIR" status >/dev/null 2>&1; then
 "$PG_BIN/pg_ctl" -D "$LAB_DB_DIR" -l "$LAB_DB_DIR/server.log" -o "-h 127.0.0.1 -p 55432 -k /tmp" start
fi
if ! "$PG_BIN/psql" -h 127.0.0.1 -p 55432 -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='project_lab'" | grep -q 1; then
 "$PG_BIN/createdb" -h 127.0.0.1 -p 55432 project_lab
fi
"$PG_BIN/pg_isready" -h 127.0.0.1 -p 55432 -d project_lab
