-- 012: 首页追加影票热映楼层（2026-09-27，D先生 确认排入默认首页）
-- 仅对 published 的 home 追加 movie-box 楼层（置于商品流之前），幂等：已有 movie-box 楼层则跳过
-- 楼层定义与 packages/renderer/schema/default-home.json 的 f-movie 保持同源
--
-- 2026-11-10 修复：首页 schema 存在两种形态——
--   003/004 写入的是信封 {"version":1,"page":"home","floors":[…]}
--   deploy/scripts/seed.mjs §8 写入的是根级数组 [{component_id,…}]（无 floors 键）
-- 原实现对根级数组取 schema_json->'floors' 得到 NULL，jsonb_set 写入 NULL 后触发
-- page_schema.schema_json NOT NULL 违约，空库或「先 seed 再迁移」的库会整条迁移链中断。
-- 现改为：只处理信封结构，其余结构跳过并告警，不再让缺键变成硬失败。
DO $$
DECLARE n int; skipped int;
BEGIN
  SELECT count(*) INTO skipped
    FROM page_schema
   WHERE page = 'home' AND status = 'published'
     AND jsonb_typeof(schema_json -> 'floors') IS DISTINCT FROM 'array';
  IF skipped > 0 THEN
    RAISE WARNING '012: % 条 published home 不是 floors 信封结构（可能由 seed.mjs 写入根级数组），已跳过影票楼层注入', skipped;
  END IF;

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
  RAISE NOTICE '012: 影票楼层注入 % 行（跳过 % 行非信封结构）', n, skipped;
END $$;
