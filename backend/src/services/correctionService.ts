import { ApiResponse } from '../types';
import pool from '../db/pool';
import { calculatePoints, calculateNoShowPenalty } from './pointsCalculator';
import { calculateLevel, checkNewBadges } from './badgeService';
import { recalculateCreditScore, logCreditChangeTx } from './creditService';
import { logger } from '../utils/logger';
import { messages } from '../constants/messages';

const PG_UNIQUE_VIOLATION = '23505';

const isUniqueViolation = (error: unknown): boolean => {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === PG_UNIQUE_VIOLATION;
};

export interface CorrectionPayload {
  corrected_duration_hours?: number;
  corrected_service_type?: string;
  corrected_rating?: number;
  reason: string;
}

const CORRECTION_LIST_SELECT = `
  SELECT c.*,
         v.name AS volunteer_name,
         sr.duration_hours AS record_duration_hours,
         sr.service_type AS record_service_type,
         sr.rating AS record_rating,
         sr.points_earned AS record_points_earned,
         sr.is_no_show AS record_is_no_show
  FROM correction_requests c
  JOIN volunteers v ON v.id = c.volunteer_id
  JOIN service_records sr ON sr.id = c.record_id
`;

export const createCorrectionRequest = async (
  recordId: string,
  volunteerId: string,
  payload: CorrectionPayload
): Promise<ApiResponse<any>> => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const recordResult = await client.query(
      'SELECT * FROM service_records WHERE id = $1 FOR UPDATE',
      [recordId]
    );

    if (recordResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.volunteers.serviceRecordNotFound };
    }

    const record = recordResult.rows[0];

    if (record.volunteer_id !== volunteerId) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.corrections.onlyOwnRecords };
    }

    const existingResult = await client.query(
      'SELECT status FROM correction_requests WHERE record_id = $1',
      [recordId]
    );

    if (existingResult.rows.length > 0) {
      await client.query('ROLLBACK');
      const error = existingResult.rows[0].status === 'pending'
        ? messages.corrections.pendingExists
        : messages.corrections.alreadySubmitted;
      return { success: false, error };
    }

    const insertResult = await client.query(
      `INSERT INTO correction_requests
        (record_id, volunteer_id, original_duration_hours, original_service_type, original_rating,
         corrected_duration_hours, corrected_service_type, corrected_rating, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        recordId,
        volunteerId,
        record.duration_hours,
        record.service_type,
        record.rating,
        payload.corrected_duration_hours ?? null,
        payload.corrected_service_type ?? null,
        payload.corrected_rating ?? null,
        payload.reason,
      ]
    );

    await client.query('COMMIT');
    return { success: true, data: insertResult.rows[0] };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (isUniqueViolation(error)) {
      return { success: false, error: messages.corrections.pendingExists };
    }
    logger.error(messages.logs.createCorrectionFailed, error);
    return { success: false, error: messages.corrections.createFailed };
  } finally {
    client.release();
  }
};

export const handleCorrectionRequest = async (
  correctionId: string,
  action: 'approve' | 'reject',
  adminId: string,
  resolution?: string
): Promise<ApiResponse<any>> => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 先无锁读取，确定记录归属后按 service_records -> correction_requests 的顺序加锁，
    // 与管理员删除记录流程的加锁顺序保持一致，避免死锁。
    const lookupResult = await client.query(
      'SELECT * FROM correction_requests WHERE id = $1',
      [correctionId]
    );

    if (lookupResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.corrections.notFound };
    }

    const lookup = lookupResult.rows[0];

    await client.query('SELECT 1 FROM service_records WHERE id = $1 FOR UPDATE', [lookup.record_id]);

    const correctionResult = await client.query(
      'SELECT * FROM correction_requests WHERE id = $1 FOR UPDATE',
      [correctionId]
    );

    const correction = correctionResult.rows[0];

    // 并发批准/驳回只生效一次：后到的事务在拿到锁后看到的已不是 pending
    if (correction.status !== 'pending') {
      await client.query('ROLLBACK');
      return { success: false, error: messages.corrections.alreadyHandled };
    }

    const finalResolution = resolution
      || (action === 'approve'
        ? messages.corrections.defaultApproveResolution
        : messages.corrections.defaultRejectResolution);

    if (action === 'reject') {
      const updatedResult = await client.query(
        `UPDATE correction_requests
         SET status = 'rejected', handled_by = $1, resolution = $2, handled_at = CURRENT_TIMESTAMP
         WHERE id = $3
         RETURNING *`,
        [adminId, finalResolution, correctionId]
      );

      await client.query(
        `INSERT INTO admin_audit_logs (admin_id, action, target_type, target_id, old_value, new_value, reason)
         VALUES ($1, 'reject_correction', 'correction_request', $2, $3, $4, $5)`,
        [
          adminId,
          correctionId,
          { status: 'pending' },
          { status: 'rejected' },
          finalResolution,
        ]
      );

      await client.query('COMMIT');

      // 驳回保持原记录与统计不变
      return {
        success: true,
        message: messages.corrections.rejected,
        data: { correction: updatedResult.rows[0] },
      };
    }

    const recordResult = await client.query(
      'SELECT * FROM service_records WHERE id = $1 FOR UPDATE',
      [correction.record_id]
    );

    if (recordResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.volunteers.serviceRecordNotFound };
    }

    const record = recordResult.rows[0];

    const volunteerResult = await client.query(
      'SELECT * FROM volunteers WHERE id = $1 FOR UPDATE',
      [correction.volunteer_id]
    );

    if (volunteerResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.volunteers.notFound };
    }

    const volunteer = volunteerResult.rows[0];

    const newDuration = correction.corrected_duration_hours != null
      ? Number(correction.corrected_duration_hours)
      : Number(record.duration_hours);
    const newType = correction.corrected_service_type ?? record.service_type;
    const newRating = correction.corrected_rating ?? record.rating;

    // 按更正值重算该条记录的积分贡献，再与旧贡献做差额调整
    const oldPointsEarned = record.points_earned || 0;
    const newPointsEarned = record.is_no_show ? 0 : calculatePoints(newDuration, newType, newRating);
    const oldContribution = record.is_no_show ? -calculateNoShowPenalty() : oldPointsEarned;
    const newContribution = record.is_no_show ? -calculateNoShowPenalty() : newPointsEarned;
    const pointsChange = newContribution - oldContribution;

    const oldTotalPoints = volunteer.total_points;
    const newTotalPoints = Math.max(0, oldTotalPoints + pointsChange);
    const oldLevel = volunteer.level;
    const newLevel = calculateLevel(newTotalPoints);

    const updatedRecordResult = await client.query(
      `UPDATE service_records
       SET duration_hours = $1, service_type = $2, rating = $3, points_earned = $4
       WHERE id = $5
       RETURNING *`,
      [newDuration, newType, newRating, newPointsEarned, record.id]
    );

    await client.query(
      'UPDATE volunteers SET total_points = $1, level = $2 WHERE id = $3',
      [newTotalPoints, newLevel, volunteer.id]
    );

    await client.query(
      `INSERT INTO points_logs (volunteer_id, change_amount, reason, before_points, after_points, related_id, related_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        volunteer.id,
        pointsChange,
        `服务记录纠错-积分重算: ${record.service_type} -> ${newType}`,
        oldTotalPoints,
        newTotalPoints,
        record.id,
        'correction',
      ]
    );

    // 纠错后积分上升可能解锁新徽章
    let newBadges: any[] = [];
    if (newLevel > oldLevel) {
      const currentBadgesResult = await client.query(
        'SELECT * FROM badges WHERE volunteer_id = $1 FOR UPDATE',
        [volunteer.id]
      );
      newBadges = await checkNewBadges(volunteer.id, newLevel, currentBadgesResult.rows, client);
    }

    // 信用分在同一事务内按更正值重算，保证记录、积分、信用与明细同时生效
    const creditResult = await recalculateCreditScore(volunteer.id, client);
    let creditChange = 0;
    if (creditResult && creditResult.changeAmount !== 0) {
      creditChange = creditResult.changeAmount;
      await logCreditChangeTx(
        client,
        volunteer.id,
        creditChange,
        `服务记录纠错-信用分重算: ${record.service_type} -> ${newType}`,
        creditResult.beforeScore,
        creditResult.afterScore,
        record.id,
        'correction'
      );
    }

    // 条件更新兜底：极端并发下若申请已被处理，整体回滚，不留下半更新
    const updatedCorrectionResult = await client.query(
      `UPDATE correction_requests
       SET status = 'approved', handled_by = $1, resolution = $2, handled_at = CURRENT_TIMESTAMP
       WHERE id = $3 AND status = 'pending'
       RETURNING *`,
      [adminId, finalResolution, correctionId]
    );

    if (updatedCorrectionResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.corrections.alreadyHandled };
    }

    await client.query(
      `INSERT INTO admin_audit_logs (admin_id, action, target_type, target_id, old_value, new_value, reason)
       VALUES ($1, 'approve_correction', 'correction_request', $2, $3, $4, $5)`,
      [
        adminId,
        correctionId,
        {
          duration_hours: record.duration_hours,
          service_type: record.service_type,
          rating: record.rating,
          points_earned: oldPointsEarned,
          total_points: oldTotalPoints,
          level: oldLevel,
        },
        {
          duration_hours: newDuration,
          service_type: newType,
          rating: newRating,
          points_earned: newPointsEarned,
          total_points: newTotalPoints,
          level: newLevel,
          credit_change: creditChange,
        },
        finalResolution,
      ]
    );

    await client.query('COMMIT');

    return {
      success: true,
      message: messages.corrections.approved,
      data: {
        correction: updatedCorrectionResult.rows[0],
        record: updatedRecordResult.rows[0],
        pointsChange,
        oldTotalPoints,
        newTotalPoints,
        oldLevel,
        newLevel,
        levelUp: newLevel > oldLevel,
        newBadges,
        creditScore: creditResult ? creditResult.afterScore : volunteer.credit_score,
        creditChange,
        creditBreakdown: creditResult?.breakdown,
      },
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    logger.error(messages.logs.handleCorrectionFailed, error);
    return { success: false, error: messages.corrections.handleFailed };
  } finally {
    client.release();
  }
};

export const getCorrectionRequests = async (
  page: number = 1,
  pageSize: number = 20,
  filters: { status?: string; volunteerId?: string; recordId?: string } = {}
): Promise<ApiResponse<any>> => {
  const client = await pool.connect();

  try {
    const offset = (page - 1) * pageSize;
    const where: string[] = [];
    const params: any[] = [];

    if (filters.status) {
      params.push(filters.status);
      where.push(`c.status = $${params.length}`);
    }
    if (filters.volunteerId) {
      params.push(filters.volunteerId);
      where.push(`c.volunteer_id = $${params.length}`);
    }
    if (filters.recordId) {
      params.push(filters.recordId);
      where.push(`c.record_id = $${params.length}`);
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const countResult = await client.query(
      `SELECT COUNT(*) AS total FROM correction_requests c ${whereClause}`,
      params
    );

    const listParams = [...params, pageSize, offset];
    const result = await client.query(
      `${CORRECTION_LIST_SELECT}
       ${whereClause}
       ORDER BY c.created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      listParams
    );

    return {
      success: true,
      data: {
        corrections: result.rows,
        pagination: {
          page,
          page_size: pageSize,
          total: parseInt(countResult.rows[0].total),
          total_pages: Math.ceil(parseInt(countResult.rows[0].total) / pageSize),
        },
      },
    };
  } finally {
    client.release();
  }
};

export const getCorrectionRequestById = async (
  correctionId: string
): Promise<ApiResponse<any>> => {
  const client = await pool.connect();

  try {
    const result = await client.query(
      `${CORRECTION_LIST_SELECT} WHERE c.id = $1`,
      [correctionId]
    );

    if (result.rows.length === 0) {
      return { success: false, error: messages.corrections.notFound };
    }

    return { success: true, data: result.rows[0] };
  } finally {
    client.release();
  }
};
