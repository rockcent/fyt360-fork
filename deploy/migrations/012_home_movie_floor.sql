-- 012: 首页追加影票热映楼层（2026-09-27，D先生 确认排入默认首页）
-- 唯一结构合同 = packages/renderer/schema/page-v1.schema.json
-- 唯一内容真源 = packages/renderer/schema/default-home.json（7 层，含 f-movie）
-- 楼层定义与真源的 f-movie 保持同源
--
-- 2026-11-10 彻底治理：
--   历史上存在两种形态：003/004 写信封 {"version","page","floors":[…]}，
--   deploy/scripts/seed.mjs §8 曾写根级数组 [{…}]（现已改为读同一真源）。
--   原实现对根级数组取 ->'floors' 得 NULL，jsonb_set 写 NULL 触发
--   page_schema.schema_json NOT NULL 违约，空库/先 seed 的库整条迁移链中断。
--   上一轮修复是「跳过非信封」，会静默丢影票楼层；本轮改为「先自愈规范化再注入」。
--   ⚠️ migrate.mjs 每次全量重跑全部 SQL（无迁移记录表），因此本迁移本身就是
--      升级路径的收敛点；041 再加数据库 CHECK 约束把结构锁死，形成双保险。
DO $$
DECLARE n int; fixed int; fixed2 int;
BEGIN
  -- ① 自愈：历史根级数组 → page-v1 信封（幂等，第二次命中 0 行）
  UPDATE page_schema
     SET schema_json = jsonb_build_object(
           'version', 1,
           'page', page,
           'floors', schema_json
         ),
         updated_at = now()
   WHERE jsonb_typeof(schema_json) = 'array';
  GET DIAGNOSTICS fixed = ROW_COUNT;

  -- ② 补 page / floors 键（DIY 草稿、AI 新建页曾写 {floors:[…]} 或 {} 形态）
  UPDATE page_schema
     SET schema_json = jsonb_set(schema_json, '{page}', to_jsonb(page), true)
   WHERE jsonb_typeof(schema_json) = 'object'
     AND NOT (schema_json ? 'page');
  UPDATE page_schema
     SET schema_json = jsonb_set(schema_json, '{floors}', '[]'::jsonb, true)
   WHERE jsonb_typeof(schema_json) = 'object'
     AND jsonb_typeof(schema_json -> 'floors') IS DISTINCT FROM 'array';
  GET DIAGNOSTICS fixed2 = ROW_COUNT;

  IF fixed > 0 OR fixed2 > 0 THEN
    RAISE NOTICE '012: 自愈规范化 % 条根级数组 + % 条缺键首页为 page-v1 信封', fixed, fixed2;
  END IF;

  -- ③ 注入影票楼层（严格面向信封；此后 041 约束保证不可能再出现非信封）
  UPDATE page_schema
     SET schema_json = jsonb_set(
           schema_json,
           '{floors}',
           (schema_json -> 'floors') || '[{"type":"movie-box","floor_id":"f-movie","component_id":"c-movie","props":{"mode":"hot","title":"","more":"","brand_code":"life_01"}}]'::jsonb
         ),
         version = version + 1,
         updated_at = now()
   WHERE page = 'home'
     AND status = 'published'
     AND jsonb_typeof(schema_json -> 'floors') = 'array'
     AND NOT EXISTS (
           SELECT 1 FROM jsonb_array_elements(schema_json -> 'floors') f
            WHERE f ->> 'type' = 'movie-box'
         );
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE '012: 影票楼层注入 % 行', n;
END $$;
