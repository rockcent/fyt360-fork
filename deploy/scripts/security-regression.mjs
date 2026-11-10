// 跨站越权回归矩阵（可重复执行；由 ci-gate.sh 在隔离空库 + 临时 API 服务上调用）
// 需要环境变量：DATABASE_URL / JWT_SECRET / BASE_URL
// 2026-11-10 建立：修复前 SECURE=NO(6/10)，修复后 SECURE=YES(10/10)
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pg = require('pg');
const jwt = require('jsonwebtoken');

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const BASE = process.env.BASE_URL;
const SECRET = process.env.JWT_SECRET;
const q = async (sql, p = []) => (await pool.query(sql, p)).rows;

async function call(method, url, token, body) {
  const r = await fetch(BASE + url, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let j = {};
  try { j = JSON.parse(text); } catch { j = { raw: text.slice(0, 160) }; }
  return { status: r.status, code: j.code ?? j.error?.code ?? '', msg: j.message ?? j.msg ?? j.raw ?? '' };
}

async function main() {
  const A = (await q(`SELECT site_id::text AS id FROM site WHERE code = 'site-a' LIMIT 1`))[0]?.id;
  if (!A) throw new Error('site-a 不存在，请先跑 seed');
  await q(`INSERT INTO site (code, name, status) VALUES ('site-b', '越权回归站B', 'active')
           ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name`);
  const B = (await q(`SELECT site_id::text AS id FROM site WHERE code = 'site-b' LIMIT 1`))[0].id;

  // 每次重建测试数据，保证重复运行结果可比
  await q(`DELETE FROM withdraw WHERE user_id IN (SELECT user_id FROM "user" WHERE invite_code LIKE 'SEC_A_%')`);
  await q(`DELETE FROM verify_agent WHERE user_id IN (SELECT user_id FROM "user" WHERE invite_code LIKE 'SEC_A_%')`);
  await q(`DELETE FROM promoter WHERE user_id IN (SELECT user_id FROM "user" WHERE invite_code LIKE 'SEC_A_%')`);
  await q(`DELETE FROM coupon WHERE name = '越权回归券'`);
  await q(`DELETE FROM "user" WHERE invite_code LIKE 'SEC_A_%'`);

  const suffix = Date.now().toString(36);
  const u = (await q(`INSERT INTO "user" (site_id, nickname, invite_code) VALUES ($1::uuid, '越权回归用户A', $2)
                      RETURNING user_id::text AS id`, [A, `SEC_A_${suffix}`]))[0].id;
  await q(`INSERT INTO promoter (user_id, invite_code, commission_balance) VALUES ($1::bigint, $2, 100)`,
    [u, `SEC_P_${suffix}`]);
  const mkWithdraw = async () => (await q(
    `INSERT INTO withdraw (user_id, amount, status) VALUES ($1::bigint, 10.00, 'pending') RETURNING id::text AS id`, [u]))[0].id;
  const w = [await mkWithdraw(), await mkWithdraw(), await mkWithdraw(), await mkWithdraw(), await mkWithdraw()];
  const agent = (await q(`INSERT INTO verify_agent (site_id, user_id, role) VALUES ($1::uuid, $2::bigint, 'verifier')
                          RETURNING id::text AS id`, [A, u]))[0].id;
  const coupon = (await q(`INSERT INTO coupon (site_id, name, type, amount, total, status)
                           VALUES ($1::uuid, '越权回归券', 'cash_off', 5, 100, 'active') RETURNING id::text AS id`, [A]))[0].id;

  const tok = (role, siteIds, adminId, username) =>
    jwt.sign({ adminId, username, role, siteIds }, SECRET, { expiresIn: '1h' });
  const tB = tok('site_admin', [B], '900002', 'sec-b');
  const tA = tok('site_admin', [A], '900001', 'sec-a');
  const tP = tok('platform_admin', [], '900000', 'sec-platform');

  const cases = [
    ['B→营销券 PATCH',       'PATCH',  `/api/admin/marketing/coupons/${coupon}`, tB, { status: 'disabled' }, 403],
    ['B→营销券 DELETE',      'DELETE', `/api/admin/marketing/coupons/${coupon}`, tB, undefined,              403],
    ['B→提现 approve',       'POST',   `/api/admin/withdraw/${w[0]}/approve`,   tB, {},                     403],
    ['B→提现 reject',        'POST',   `/api/admin/withdraw/${w[1]}/reject`,    tB, { reason: '越权回归' },  403],
    ['B→提现 batch-pay',     'POST',   `/api/admin/withdraw/batch-pay`,         tB, { ids: [Number(w[2])] }, 403],
    ['B→核销员 PATCH',       'PATCH',  `/api/admin/verify/agents/${agent}`,     tB, { status: 'disabled' }, 403],
    ['A→营销券 PATCH(本站)', 'PATCH',  `/api/admin/marketing/coupons/${coupon}`, tA, { status: 'active' },  200],
    ['A→提现 approve(本站)', 'POST',   `/api/admin/withdraw/${w[3]}/approve`,   tA, {},                     200],
    ['A→核销员 PATCH(本站)', 'PATCH',  `/api/admin/verify/agents/${agent}`,     tA, { status: 'active' },   200],
    ['平台→提现 approve',    'POST',   `/api/admin/withdraw/${w[4]}/approve`,   tP, {},                     200],
  ];

  console.log('\n[security-regression] 跨站越权矩阵');
  console.log('case'.padEnd(26) + 'expect  actual  code              result');
  console.log('-'.repeat(86));
  let pass = 0;
  for (const [name, method, url, token, body, expect] of cases) {
    const r = await call(method, url, token, body);
    const ok = r.status === expect;
    if (ok) pass++;
    console.log(name.padEnd(26) + String(expect).padEnd(8) + String(r.status).padEnd(8)
      + String(r.code).padEnd(18) + (ok ? 'PASS' : `FAIL ${String(r.msg).slice(0, 40)}`));
  }
  console.log('-'.repeat(86));
  console.log(`[security-regression] ${pass}/${cases.length}  SECURE=${pass === cases.length ? 'YES' : 'NO'}`);
  await pool.end();
  process.exit(pass === cases.length ? 0 : 1);
}

main().catch((e) => { console.error('[security-regression] 失败:', e.message); process.exit(2); });
