-- 041: 首页 Schema 结构真源收敛（补齐 040→042 断号）
--
-- 背景：001 建表时 schema_json DEFAULT '[]'::jsonb 是「根级组件树」旧约定；
--       003/004 与 packages/renderer/schema/default-home.json 用的是 page-v1 信封
--       {"version","page","floors":[…]}；seed.mjs §8 又曾写根级数组。
--       四层各说各话，导致 012 影票楼层注入在空库上 NOT NULL 违约。
--
-- 本迁移只锁「结构合同」，不锁「页面内容」：
--   运营 DIY 装修结果 / AI 生成页 / 历史归档版本都必须原样保留，禁止覆盖。
--   内容真源只用于新站初始化（seed.mjs §8），不用于强制同步线上已发布页。
--
-- ⚠️ migrate.mjs 每次全量重跑全部 SQL（无迁移记录表），所有 DDL 必须幂等。
DO $$
DECLARE fixed int;
BEGIN
  -- ① 兜底规范化（012 已做一次；防御 012 之后由其他路径写入的脏数据）
  UPDATE page_schema
     SET schema_json = jsonb_build_object('version', 1, 'page', page, 'floors', schema_json)
   WHERE jsonb_typeof(schema_json) = 'array';
  GET DIAGNOSTICS fixed = ROW_COUNT;
  IF fixed > 0 THEN RAISE NOTICE '041: 规范化 % 条根级数组首页', fixed; END IF;

  UPDATE page_schema
     SET schema_json = jsonb_set(schema_json, '{page}', to_jsonb(page), true)
   WHERE jsonb_typeof(schema_json) = 'object' AND NOT (schema_json ? 'page');
  UPDATE page_schema
     SET schema_json = jsonb_set(schema_json, '{floors}', '[]'::jsonb, true)
   WHERE jsonb_typeof(schema_json) = 'object'
     AND jsonb_typeof(schema_json -> 'floors') IS DISTINCT FROM 'array';

  -- ② 结构约束（幂等）：只要求 object + page 键 + floors 数组；
  --    不强制 version，兼容历史 DIY 草稿 {page,floors,title}。
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'page_schema_envelope_ck') THEN
    ALTER TABLE page_schema ADD CONSTRAINT page_schema_envelope_ck
      CHECK (
        jsonb_typeof(schema_json) = 'object'
        AND schema_json ? 'page'
        AND jsonb_typeof(schema_json -> 'floors') = 'array'
      );
    RAISE NOTICE '041: 已添加 page_schema_envelope_ck';
  END IF;
END $$;

-- ③ 默认值改为信封（001 的 '[]' 旧约定作废）
ALTER TABLE page_schema
  ALTER COLUMN schema_json SET DEFAULT '{"version":1,"page":"home","floors":[]}'::jsonb;
