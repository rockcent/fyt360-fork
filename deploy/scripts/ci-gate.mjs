// CI 门禁：结构真源静态契约 + 运行时数据库断言
// 用法：node deploy/scripts/ci-gate.mjs
//   - 无 DATABASE_URL：只跑静态检查
//   - 有 DATABASE_URL：追加数据库断言（由 ci-gate.sh 在隔离空库跑完 migrate/seed 后调用）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const results = [];
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const read = (p) => fs.readFileSync(path.join(repoRoot, p), 'utf8');
const readBytes = (p) => fs.readFileSync(path.join(repoRoot, p));

function check(name, fn) {
  try { results.push({ name, ok: true, detail: fn() || '' }); }
  catch (e) { results.push({ name, ok: false, detail: e.message }); }
}
async function checkAsync(name, fn) {
  try { results.push({ name, ok: true, detail: (await fn()) || '' }); }
  catch (e) { results.push({ name, ok: false, detail: e.message }); }
}

// 递归收集同名文件（排除 node_modules/.git/dist/build）
function collect(name, dir = repoRoot, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'dist', 'build', '.workbuddy'].includes(ent.name)) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) collect(name, full, out);
    else if (ent.name === name) out.push(path.relative(repoRoot, full));
  }
  return out;
}

// ---------- 静态契约 ----------
check('迁移序号连续（001..N 无断号/重号）', () => {
  const nums = fs.readdirSync(path.join(repoRoot, 'deploy/migrations'))
    .filter((f) => f.endsWith('.sql'))
    .map((f) => { const m = f.match(/^(\d+)_/); assert(m, `文件名不合规: ${f}`); return Number(m[1]); })
    .sort((a, b) => a - b);
  assert(nums.length > 0, '无迁移文件');
  const dup = nums.filter((n, i) => i > 0 && n === nums[i - 1]);
  assert(dup.length === 0, `重号: ${dup.join(',')}`);
  const gaps = [];
  for (let i = 1; i < nums.length; i++) if (nums[i] !== nums[i - 1] + 1) gaps.push(`${nums[i - 1]}→${nums[i]}`);
  assert(gaps.length === 0, `断号: ${gaps.join(',')}`);
  return `${nums[0]}..${nums.at(-1)} 共 ${nums.length} 个`;
});

const CANON_HOME = 'packages/renderer/schema/default-home.json';
const CANON_CONTRACT = 'packages/renderer/schema/page-v1.schema.json';

check('canonical default-home 符合 page-v1 信封', () => {
  const d = JSON.parse(read(CANON_HOME));
  assert(d.version === 1, 'version 应为 1');
  assert(d.page === 'home', 'page 应为 home');
  assert(Array.isArray(d.floors) && d.floors.length > 0, 'floors 须为非空数组');
  assert(d.floors.every((f) => typeof f.type === 'string'), '每个楼层须有 type');
  assert(d.floors.some((f) => f.type === 'movie-box'), '真源须含 movie-box（012 同源代码）');
  return `${d.floors.length} 层`;
});

check('canonical page-v1.schema.json required 完整', () => {
  const s = JSON.parse(read(CANON_CONTRACT));
  for (const k of ['version', 'page', 'floors']) assert(s.required?.includes(k), `required 缺少 ${k}`);
  return `required=[${s.required.join(',')}]`;
});

check('所有 default-home.json 副本与 canonical 一致', () => {
  const canon = readBytes(CANON_HOME);
  const files = collect('default-home.json');
  const drift = files.filter((f) => !readBytes(f).equals(canon));
  assert(drift.length === 0, `漂移副本: ${drift.join(', ')}`);
  return `${files.length} 份一致`;
});

check('所有 page-v1.schema.json 副本与 canonical 一致', () => {
  const canon = readBytes(CANON_CONTRACT);
  const files = collect('page-v1.schema.json');
  const drift = files.filter((f) => !readBytes(f).equals(canon));
  assert(drift.length === 0, `漂移副本: ${drift.join(', ')}`);
  return `${files.length} 份一致`;
});

check('seed.mjs 从 canonical 读首页且 fail-fast', () => {
  const s = read('deploy/scripts/seed.mjs');
  assert(s.includes('default-home.json'), '未引用 canonical 真源');
  assert(s.includes('JSON.stringify(homeSchema)'), '未写入 homeSchema');
  assert(!s.includes("component_id: 'c1'"), '仍残留根级数组硬编码');
  assert(s.includes('Array.isArray(homeSchema.floors)'), '缺少信封结构校验');
  return 'fail-fast + 信封校验';
});

check('041 结构约束迁移存在且幂等', () => {
  const f = fs.readdirSync(path.join(repoRoot, 'deploy/migrations')).find((x) => x.startsWith('041_'));
  assert(f, '041 缺失');
  const s = read(`deploy/migrations/${f}`);
  assert(s.includes('page_schema_envelope_ck'), '缺少结构约束');
  assert(s.includes('IF NOT EXISTS'), '约束添加未做幂等');
  assert(s.includes('SET DEFAULT'), '未修正 001 的根级数组默认值');
  return f;
});

check('高危写接口均带站点归属校验（防回归）', () => {
  for (const [file, fn] of [
    ['server/src/routes/marketing.ts', 'loadCouponOwnership'],
    ['server/src/routes/withdraw.ts', 'loadWithdrawOwnership'],
    ['server/src/routes/verify.ts', 'loadAgentOwnership'],
  ]) {
    const s = read(file);
    assert(s.includes(`function ${fn}`), `${file} 缺少 ${fn}`);
    assert(s.includes('assertSiteAccess'), `${file} 未调用 assertSiteAccess`);
  }
  const w = read('server/src/routes/withdraw.ts');
  assert((w.match(/loadWithdrawOwnership\(/g) || []).length >= 4, 'withdraw 三接口未全部接入归属校验');
  return 'marketing / withdraw / verify 覆盖';
});

// ---------- 运行时数据库断言 ----------
const dbUrl = process.env.DATABASE_URL;
if (dbUrl && !dbUrl.includes('user:password@host')) {
  const pg = require('pg');
  const pool = new pg.Pool({ connectionString: dbUrl });
  const one = async (sql) => (await pool.query(sql)).rows[0];

  await checkAsync('page_schema 全部为 page-v1 信封', async () => {
    const r = await one(`SELECT count(*)::int AS n FROM page_schema
       WHERE jsonb_typeof(schema_json) <> 'object'
          OR NOT (schema_json ? 'page')
          OR jsonb_typeof(schema_json -> 'floors') <> 'array'`);
    assert(r.n === 0, `${r.n} 行非信封结构`);
    const t = await one(`SELECT count(*)::int AS n FROM page_schema`);
    return `${t.n} 行全部合规`;
  });

  await checkAsync('041 约束已落到数据库', async () => {
    const r = await one(`SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'page_schema_envelope_ck'`);
    assert(r.n === 1, '约束未创建');
    return 'page_schema_envelope_ck';
  });

  await checkAsync('published home 含 movie-box（012 未空转）', async () => {
    const r = await one(`SELECT count(*)::int AS n FROM page_schema
       WHERE page='home' AND status='published'
         AND EXISTS (SELECT 1 FROM jsonb_array_elements(schema_json->'floors') f WHERE f->>'type'='movie-box')`);
    assert(r.n > 0, '首页缺影票楼层');
    return `${r.n} 个已发布首页`;
  });

  await checkAsync('plugin 配置轨已落地（>=9）', async () => {
    const r = await one(`SELECT count(*)::int AS n FROM brand_action_cfg WHERE action_type='plugin'`);
    assert(r.n >= 9, `plugin 仅 ${r.n} 行`);
    return `${r.n} 行`;
  });

  await checkAsync('member_level 已站点级化（045 生效）', async () => {
    const r = await one(`SELECT is_nullable FROM information_schema.columns
       WHERE table_name='member_level' AND column_name='site_id'`);
    assert(r && r.is_nullable === 'NO', 'member_level.site_id 缺失或可空');
    return 'site_id NOT NULL';
  });

  await pool.end();
} else {
  console.log('[ci-gate] 未提供 DATABASE_URL，跳过运行时数据库断言');
}

console.log('\n[ci-gate] 静态 + 运行时断言');
console.log('-'.repeat(88));
let pass = 0;
for (const r of results) {
  if (r.ok) pass++;
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(50)} ${r.detail}`);
}
console.log('-'.repeat(88));
console.log(`[ci-gate] ${pass}/${results.length}  ${pass === results.length ? 'GATE=PASS' : 'GATE=FAIL'}`);
process.exit(pass === results.length ? 0 : 1);
