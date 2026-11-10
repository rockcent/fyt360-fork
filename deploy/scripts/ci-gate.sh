#!/usr/bin/env bash
# CI 门禁编排：隔离空库全链 → 静态/DB 断言 → 临时 API 服务 → 跨站越权回归
# 幂等、自清理；不触碰任何真实数据库。用法：npm run ci:gate
set -u
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
PGD="${CI_GATE_PGDATA:-/tmp/fyt-ci-gate-pg}"
PGPORT="${CI_GATE_PGPORT:-55433}"
APIPORT="${CI_GATE_APIPORT:-19100}"
SLOG=/tmp/fyt-ci-gate-server.log
SPID=""
RC=0

cleanup() {
  [ -n "$SPID" ] && kill "$SPID" 2>/dev/null
  if command -v pg_ctl >/dev/null 2>&1; then pg_ctl -D "$PGD" stop -m immediate >/dev/null 2>&1; fi
  rm -rf "$PGD"
}
trap cleanup EXIT

cd "$REPO" || exit 2

# 无本地 PG 时降级为静态门禁（CI 上可显式提供 initdb）
if ! command -v initdb >/dev/null 2>&1; then
  for d in /opt/homebrew/opt/postgresql@*/bin /usr/local/opt/postgresql@*/bin; do
    if [ -x "$d/initdb" ]; then export PATH="$d:$PATH"; break; fi
  done
fi
if ! command -v initdb >/dev/null 2>&1; then
  echo "[ci-gate] 未找到 initdb，仅执行静态契约检查（跳过运行时）"
  node deploy/scripts/ci-gate.mjs
  exit $?
fi

pg_ctl -D "$PGD" stop -m immediate >/dev/null 2>&1
rm -rf "$PGD"
initdb -D "$PGD" -U postgres --no-locale --encoding=UTF8 >/dev/null 2>&1 || { echo "initdb 失败"; exit 2; }
pg_ctl -D "$PGD" -o "-p $PGPORT -h 127.0.0.1" -l /tmp/fyt-ci-gate-pg.log start >/dev/null 2>&1 || {
  tail -20 /tmp/fyt-ci-gate-pg.log; exit 2; }
createdb -h 127.0.0.1 -p "$PGPORT" -U postgres fyt_ci_gate || exit 2

export DATABASE_URL="postgresql://postgres@127.0.0.1:${PGPORT}/fyt_ci_gate"
export JWT_SECRET="ci-gate-secret-20261110"
export TCB_ENV="ci-test"
export PORT="$APIPORT"
export BASE_URL="http://127.0.0.1:${APIPORT}"

for stage in "migrate#1" "seed" "migrate#2(3b)" "migrate#3(幂等)"; do
  case "$stage" in
    "seed") CMD="node deploy/scripts/seed.mjs" ;;
    *)      CMD="node deploy/scripts/migrate.mjs" ;;
  esac
  echo "[ci-gate] $stage ..."
  if ! $CMD > /tmp/fyt-ci-gate-stage.log 2>&1; then
    echo "[ci-gate] $stage FAILED"; tail -30 /tmp/fyt-ci-gate-stage.log; exit 1
  fi
done

echo "[ci-gate] 静态 + 数据库断言 ..."
node deploy/scripts/ci-gate.mjs || RC=1

echo "[ci-gate] 启动临时 API ..."
"$REPO/node_modules/.bin/tsx" "$REPO/server/src/index.ts" > "$SLOG" 2>&1 &
SPID=$!
for _ in $(seq 1 60); do
  nc -z 127.0.0.1 "$APIPORT" 2>/dev/null && break
  sleep 0.5
done
if ! nc -z 127.0.0.1 "$APIPORT" 2>/dev/null; then
  echo "[ci-gate] API 未就绪"; tail -30 "$SLOG"; exit 1
fi

echo "[ci-gate] 跨站越权回归 ..."
node deploy/scripts/security-regression.mjs || RC=1

echo "[ci-gate] ===== $( [ "$RC" -eq 0 ] && echo 'GATE=PASS' || echo 'GATE=FAIL' ) ====="
exit "$RC"
