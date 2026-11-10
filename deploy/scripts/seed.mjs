// seed：初始数据（幂等 ON CONFLICT）
// 范围 = M1 开工计划：159 业务入口 / 23 组件 / L1-L3 / 三角色 + 平台超管 / 示例站点 A
import fs from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { loadDotEnv, repoRoot } from './lib/common.mjs';
import { connectDb } from './lib/db.mjs';
import { categories } from '../seed/data-entries.mjs';
import { components } from '../seed/data-components.mjs';
import { memberLevels, roles, sampleSite } from '../seed/data-system.mjs';

/** 列是否存在：同一份 seed 要同时适配 045 站点级化前后的 member_level */
async function columnExists(client, table, column) {
  const { rows } = await client.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_name = $1 AND column_name = $2 LIMIT 1`,
    [table, column]
  );
  return rows.length > 0;
}

async function main() {
  loadDotEnv();
  const client = await connectDb();
  const inTx = client.backend === 'direct'; // tcbapi 后端逐条执行、无会话事务，靠幂等补偿
  const stats = {};
  try {
    if (inTx) await client.query('BEGIN');

    // 1. 品牌 10 大分类
    for (const c of categories) {
      await client.query(
        `INSERT INTO brand_category (code, name, sort) VALUES ($1,$2,$3)
         ON CONFLICT (code) DO NOTHING`,
        [c.code, c.name, c.sort]
      );
    }
    stats.categories = categories.length;

    // 2. 159 业务入口 → brand_action_cfg（先校验总数再写库）
    const entryCount = categories.reduce((n, c) => n + c.entries.length, 0);
    if (entryCount !== 159) throw new Error(`入口数 ${entryCount} ≠ 159，终止`);
    for (const c of categories) {
      for (let i = 0; i < c.entries.length; i++) {
        await client.query(
          `INSERT INTO brand_action_cfg (site_scope, category, brand_code, name, action_type, enabled)
           VALUES ('all', $1, $2, $3, 'launch', TRUE)
           ON CONFLICT (site_scope, category, brand_code) DO NOTHING`,
          [c.code, `${c.code}_${String(i + 1).padStart(2, '0')}`, c.entries[i]]
        );
      }
    }
    stats.entries = entryCount;

    // 3. 23 组件模板库
    for (const comp of components) {
      await client.query(
        `INSERT INTO component_template (code, name, category, schema_tpl)
         VALUES ($1,$2,$3,$4::jsonb)
         ON CONFLICT (code) DO NOTHING`,
        [comp.code, comp.name, comp.category, JSON.stringify(comp.schema_tpl)]
      );
    }
    stats.components = components.length;

    // 4. 示例站点 A（前移：045 站点级化之后 member_level 必须带 site_id）
    const siteRes = await client.query(
      `INSERT INTO site (code, name, theme, status) VALUES ($1,$2,$3::jsonb,'active')
       ON CONFLICT (code) DO NOTHING
       RETURNING site_id`,
      [sampleSite.code, sampleSite.name, JSON.stringify(sampleSite.theme)]
    );
    stats.siteCreated = siteRes.rowCount;
    const siteA = siteRes.rows[0]?.site_id
      ?? (await client.query(`SELECT site_id FROM site WHERE code = $1`, [sampleSite.code])).rows[0]?.site_id;
    if (!siteA) throw new Error('示例站点 A 缺失，无法写入会员等级');

    // 5. 会员等级 L1/L2/L3（§11.2）
    //    045 之前：code 全局唯一；045 之后：唯一键为 (site_id, code) 且 site_id NOT NULL。
    //    这里按实际 schema 选择插入形态，保证同一份 seed 在新库与老库都能幂等跑通。
    const levelHasSiteId = await columnExists(client, 'member_level', 'site_id');
    for (const lv of memberLevels) {
      if (levelHasSiteId) {
        await client.query(
          `INSERT INTO member_level (site_id, code, name, sort, ingot_price, self_rate, direct_rate, team_rate, team2_rate, "desc", status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active')
           ON CONFLICT (site_id, code) DO NOTHING`,
          [siteA, lv.code, lv.name, lv.sort, lv.ingot_price, lv.self_rate, lv.direct_rate, lv.team_rate, lv.team2_rate, lv.desc]
        );
      } else {
        await client.query(
          `INSERT INTO member_level (code, name, sort, ingot_price, self_rate, direct_rate, team_rate, team2_rate, "desc", status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active')
           ON CONFLICT (code) DO NOTHING`,
          [lv.code, lv.name, lv.sort, lv.ingot_price, lv.self_rate, lv.direct_rate, lv.team_rate, lv.team2_rate, lv.desc]
        );
      }
    }
    stats.memberLevels = memberLevels.length;
    stats.memberLevelSiteScoped = levelHasSiteId;

    // 6. 内置角色
    for (const r of roles) {
      await client.query(
        `INSERT INTO role (role_code, name, permissions) VALUES ($1,$2,$3::jsonb)
         ON CONFLICT (role_code) DO NOTHING`,
        [r.role_code, r.name, JSON.stringify(r.permissions)]
      );
    }
    stats.roles = roles.length;

    // 7. 平台超管（密码取 ADMIN_INIT_PASSWORD，首次登录强制改密）
    //    重复执行不覆盖已改密码
    const pwd = process.env.ADMIN_INIT_PASSWORD;
    if (pwd && pwd.trim() !== '') {
      const hash = bcrypt.hashSync(pwd, 10);
      await client.query(
        `INSERT INTO admin_user (username, password_hash, role, must_change_password)
         VALUES ('admin', $1, 'platform_admin', TRUE)
         ON CONFLICT (username) DO NOTHING`,
        [hash]
      );
      stats.adminSeeded = 1;
    } else {
      console.warn('[seed] ADMIN_INIT_PASSWORD 未设置，跳过平台超管创建（deploy 阶段会强制要求）');
    }

    // 8. 示例站点 A 默认首页 Schema
    //    唯一内容真源 = packages/renderer/schema/default-home.json（page-v1 信封，7 层）
    //    2026-11-10 修复：原此处硬编码根级数组 [{component_id,…}]，与 003/004 的
    //    {"version","page","floors"} 信封及 page-v1.schema.json 合同冲突，导致 012 取
    //    schema_json->'floors' 为 NULL → NOT NULL 违约、整条空库迁移链中断。
    //    空库时 003/004 因 site 表尚无 site-a 而空转，§8 才是首页的实际写入者，
    //    因此这里必须写对；真源缺失宁可 fail-fast，也不再写兜底空壳。
    const homeDocPath = path.join(repoRoot, 'packages', 'renderer', 'schema', 'default-home.json');
    if (!fs.existsSync(homeDocPath)) {
      throw new Error(`首页真源缺失：${homeDocPath}（拒绝写入根级数组兜底）`);
    }
    const homeSchema = JSON.parse(fs.readFileSync(homeDocPath, 'utf8'));
    if (!homeSchema || homeSchema.page !== 'home' || !Array.isArray(homeSchema.floors)) {
      throw new Error('首页真源不符合 page-v1 信封合同：需 {version,page:"home",floors:[...]}');
    }
    const { rows: siteRows } = await client.query(`SELECT site_id FROM site WHERE code = $1`, [sampleSite.code]);
    if (siteRows[0]) {
      await client.query(
        `INSERT INTO page_schema (site_id, page, schema_json, version, status, source)
         SELECT $1, 'home', $2::jsonb, 1, 'published', 'manual'
         WHERE NOT EXISTS (
           SELECT 1 FROM page_schema WHERE site_id = $1 AND page = 'home' AND status = 'published'
         )`,
        [siteRows[0].site_id, JSON.stringify(homeSchema)]
      );
      stats.homeSchema = 1;
      stats.homeFloors = homeSchema.floors.length;
    }

    if (inTx) await client.query('COMMIT');
    console.log(`[seed] 完成（幂等，后端=${client.backend}）：`, JSON.stringify(stats));
  } catch (e) {
    if (inTx) await client.query('ROLLBACK');
    throw e;
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error('[seed] 失败：', e.message);
  process.exit(1);
});
