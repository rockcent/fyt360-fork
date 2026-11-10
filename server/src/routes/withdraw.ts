// 提现审核（admin-34）：佣金现金提现 pending → paid / rejected
// ⚠️ 2026-10-10 起 C 端申请**即时到账**（me.ts 直接落 paid，无审核环节，微信审核钦定口径）；
//    本路由保留用于：存量 pending 单审核、异常单驳回退余额、打款凭证管理。
//    真实打款走微信企业付款到零钱里程碑；当前打款动作=审核通过并标记打款（打款通道接通后切换）
import { Router, type Request, type Response, type NextFunction } from 'express';
import { pool } from '../db/client.js';
import { HttpError } from '../middleware/errors.js';
import { requireAdmin, assertSiteAccess, type AdminJwtPayload } from '../middleware/auth.js';

export const withdrawRouter = Router();

/** 提现单归属：withdraw 自身无 site_id，归属由 user.site_id 推导（与列表查询同源）。
 *  2026-11-10 P0 修复：approve/reject/batch-pay 原仅按自增 id 定位，
 *  B 站管理员可跨站将他站提现单标记「已打款」或驳回退回余额（动态复现均为 200）。
 *  先查归属 → assertSiteAccess → 写语句再带站点条件（防 TOCTOU）。 */
async function loadWithdrawOwnership(admin: AdminJwtPayload, id: number): Promise<string> {
  const { rows } = await pool.query(
    `SELECT u.site_id::text AS site_id
       FROM withdraw w JOIN "user" u ON u.user_id = w.user_id
      WHERE w.id = $1::bigint LIMIT 1`,
    [id]
  );
  if (!rows[0]) throw new HttpError(404, '提现单不存在', 'WITHDRAW_NOT_FOUND');
  const siteId = String(rows[0].site_id);
  assertSiteAccess(admin, siteId);
  return siteId;
}

function withdrawId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, '提现单 id 非法', 'BAD_REQUEST');
  return id;
}

/** 站点范围：active 站点头/参数 → 单站；否则平台=全站、站点角色=自身站点 */
async function scope(admin: AdminJwtPayload, code: string): Promise<string[]> {
  if (code) {
    const { rows } = await pool.query(`SELECT site_id FROM site WHERE code = $1 LIMIT 1`, [code]);
    if (!rows[0]) throw new HttpError(404, '站点不存在', 'SITE_NOT_FOUND');
    const siteId = String(rows[0].site_id);
    if (admin.role !== 'platform_admin' && !admin.siteIds.includes(siteId)) {
      throw new HttpError(403, '无该站点权限', 'SITE_FORBIDDEN');
    }
    return [siteId];
  }
  if (admin.role === 'platform_admin') {
    const { rows } = await pool.query(`SELECT site_id::text AS id FROM site`);
    return rows.map((r) => r.id);
  }
  if (!admin.siteIds.length) throw new HttpError(403, '无站点权限', 'SITE_FORBIDDEN');
  return admin.siteIds;
}

/** 提现规则（platform_config.withdraw_rule 站点维度，045 起；fallback 平台键→默认；2026-10-10 无门槛口径 min_amount=0） */
export async function withdrawRule(siteId?: string): Promise<{ min_amount: number; fee_rate: number; per_txn_limit: number }> {
  if (siteId) {
    const { rows: siteRow } = await pool.query(
      `SELECT value FROM platform_config WHERE key = 'withdraw_rule' AND site_id = $1::uuid LIMIT 1`, [siteId]);
    if (siteRow[0]?.value) return siteRow[0].value;
  }
  const { rows } = await pool.query(`SELECT value FROM platform_config WHERE key = 'withdraw_rule' AND site_id IS NULL LIMIT 1`);
  return rows[0]?.value ?? { min_amount: 0, fee_rate: 0, per_txn_limit: 5000 };
}

/** GET /api/admin/withdraw/summary → 顶部三卡 */
withdrawRouter.get('/summary', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sites = await scope(req.admin!, String(req.query.site ?? req.headers['x-fyt-site'] ?? ''));
    const ph = sites.map((_, i) => `$${i + 1}`).join(',');
    const { rows } = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE w.status = 'pending')                       AS pending_count,
         COALESCE(SUM(w.amount) FILTER (WHERE w.status = 'pending'), 0)     AS pending_amount,
         COALESCE((SELECT SUM(amount) FROM commission_flow
                    WHERE status = 'available'
                      AND user_id IN (SELECT user_id FROM "user" WHERE site_id IN (${ph}))), 0) AS available_amount,
         (SELECT COUNT(DISTINCT cf.user_id) FROM commission_flow cf
            JOIN "user" u ON u.user_id = cf.user_id
           WHERE cf.status = 'available' AND u.site_id IN (${ph}))          AS available_users,
         COALESCE(SUM(w.amount) FILTER (WHERE w.status = 'paid'), 0)        AS paid_amount,
         COUNT(*) FILTER (WHERE w.status = 'paid')                          AS paid_count
         FROM withdraw w
         JOIN "user" u ON u.user_id = w.user_id
        WHERE u.site_id IN (${ph})`,
      sites
    );
    const rule = await withdrawRule(sites.length === 1 ? sites[0] : undefined);
    res.json({ ok: true, data: { ...rows[0], rule } });
  } catch (e) { next(e); }
});

/** GET /api/admin/withdraw?status=&page=&size= → 审核列表 */
withdrawRouter.get('/', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sites = await scope(req.admin!, String(req.query.site ?? req.headers['x-fyt-site'] ?? ''));
    const ph = sites.map((_, i) => `$${i + 1}`).join(',');
    const status = String(req.query.status ?? '');
    const statusSql = ['pending', 'approved', 'rejected', 'paid', 'failed'].includes(status)
      ? ` AND w.status = '${status}'` : '';
    const size = Math.min(Math.max(Number(req.query.size) || 20, 1), 100);
    const page = Math.max(Number(req.query.page) || 1, 1);
    const params: unknown[] = [...sites, size, (page - 1) * size];

    const { rows } = await pool.query(
      `SELECT w.id, w.amount, w.channel, w.status, w.reject_reason, w.audit_at, w.created_at, w.paid_at,
              u.user_id::text AS user_id, COALESCE(u.nickname, '用户' || u.user_id) AS nickname, u.invite_code,
              s.code AS site_code, s.name AS site_name,
              COALESCE((SELECT SUM(amount) FROM commission_flow cf
                         WHERE cf.user_id = u.user_id AND cf.status IN ('available','withdrawn')), 0) AS total_commission
         FROM withdraw w
         JOIN "user" u ON u.user_id = w.user_id
         JOIN site s ON s.site_id = u.site_id
        WHERE u.site_id IN (${ph})${statusSql}
        ORDER BY w.created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    const { rows: cnt } = await pool.query(
      `SELECT COUNT(*) AS total FROM withdraw w JOIN "user" u ON u.user_id = w.user_id
        WHERE u.site_id IN (${ph})${statusSql}`,
      sites
    );
    res.json({
      ok: true,
      data: {
        total: Number(cnt[0].total),
        page,
        size,
        items: rows.map((r) => ({
          id: Number(r.id),
          amount: Number(r.amount),
          channel: r.channel,
          channel_label: r.channel === 'wx_wallet' ? '微信零钱' : r.channel,
          status: r.status,
          reject_reason: r.reject_reason,
          created_at: r.created_at,
          audit_at: r.audit_at,
          paid_at: r.paid_at,
          user: {
            user_id: r.user_id,
            nickname: r.nickname,
            invite_code: r.invite_code,
            total_commission: Number(r.total_commission),
          },
          site: { code: r.site_code, name: r.site_name },
        })),
      },
    });
  } catch (e) { next(e); }
});

/** POST /api/admin/withdraw/:id/approve → 通过打款（pending → paid，记 audit/paid_at） */
withdrawRouter.post('/:id/approve', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = withdrawId(req.params.id);
    const siteId = await loadWithdrawOwnership(req.admin!, id);
    const { rows } = await pool.query(
      `UPDATE withdraw SET status = 'paid', audit_by = $2::bigint, audit_at = now(), paid_at = now(), reject_reason = NULL
        WHERE id = $1::bigint AND status = 'pending'
          AND user_id IN (SELECT user_id FROM "user" WHERE site_id = $3::uuid)
        RETURNING id`,
      [id, req.admin!.adminId, siteId]
    );
    if (!rows[0]) throw new HttpError(404, '记录不存在或状态不可打款', 'WITHDRAW_NOT_PENDING');
    res.json({ ok: true, data: { id: Number(rows[0].id), status: 'paid' } });
  } catch (e) { next(e); }
});

/** POST /api/admin/withdraw/:id/reject {reason} → 驳回（pending → rejected） */
withdrawRouter.post('/:id/reject', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = withdrawId(req.params.id);
    const siteId = await loadWithdrawOwnership(req.admin!, id);
    const reason = String(req.body?.reason ?? '').trim();
    if (!reason) throw new HttpError(400, '请填写驳回原因', 'BAD_REQUEST');
    // 驳回退回余额（C 端申请时已原子扣减 promoter.commission_balance，闭环）
    const { rows } = await pool.query(
      `WITH rej AS (
         UPDATE withdraw SET status = 'rejected', audit_by = $2::bigint, audit_at = now(), reject_reason = $3
          WHERE id = $1::bigint AND status = 'pending'
            AND user_id IN (SELECT user_id FROM "user" WHERE site_id = $4::uuid)
         RETURNING id, user_id, amount
       ), back AS (
         UPDATE promoter SET commission_balance = commission_balance + rej.amount
           FROM rej WHERE promoter.user_id = rej.user_id
         RETURNING 1
       )
       SELECT id, (SELECT count(*)::int FROM back) AS refunded FROM rej`,
      [id, req.admin!.adminId, reason.slice(0, 255), siteId]
    );
    if (!rows[0]) throw new HttpError(404, '记录不存在或状态不可驳回', 'WITHDRAW_NOT_PENDING');
    res.json({ ok: true, data: { id: Number(rows[0].id), status: 'rejected' } });
  } catch (e) { next(e); }
});

/** POST /api/admin/withdraw/batch-pay {ids} → 批量打款（仅 pending 生效） */
withdrawRouter.post('/batch-pay', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ids = Array.isArray(req.body?.ids)
      ? req.body.ids.map(Number).filter((n: number) => Number.isInteger(n) && n > 0) : [];
    if (!ids.length) throw new HttpError(400, '缺少提现单 ID', 'BAD_REQUEST');
    // 整批 fail-closed：任一单不属于管理员可见站点 → 整批 403，不做部分更新
    const siteIds: string[] = [];
    for (const id of ids) {
      const sid = await loadWithdrawOwnership(req.admin!, id);
      if (!siteIds.includes(sid)) siteIds.push(sid);
    }
    const { rows } = await pool.query(
      `UPDATE withdraw SET status = 'paid', audit_by = $1::bigint, audit_at = now(), paid_at = now()
        WHERE id = ANY($2::bigint[]) AND status = 'pending'
          AND user_id IN (SELECT user_id FROM "user" WHERE site_id = ANY($3::uuid[]))
        RETURNING id`,
      [req.admin!.adminId, ids, siteIds]
    );
    res.json({ ok: true, data: { paid: rows.length } });
  } catch (e) { next(e); }
});
