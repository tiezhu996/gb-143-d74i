import {
  ApiResponse,
  RecordCorrection,
  RecordCorrectionInput,
  ServiceRecord,
  Volunteer,
} from '../types';
import pool from '../db/pool';
import { calculatePoints } from './pointsCalculator';
import { calculateLevel } from './badgeService';
import { reconcileBadgesWithClient } from './badgeService';
import {
  recalculateCreditScoreWithClient,
  logCreditChangeWithClient,
} from './creditService';
import { logger } from '../utils/logger';
import { messages } from '../constants/messages';

const isUniqueViolation = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error as { code?: string }).code === '23505';

/**
 * 志愿者对本人的服务记录提交一次纠错申请。
 * 同一记录存在任意一条历史申请即不可再次提交；数据库层的部分唯一索引
 * 额外保证同一记录同时只有一条 pending 申请，即使并发提交也成立。
 */
export const createCorrection = async (
  volunteerId: string,
  serviceRecordId: string,
  input: RecordCorrectionInput
): Promise<ApiResponse<RecordCorrection>> => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const recordResult = await client.query(
      'SELECT * FROM service_records WHERE id = $1 FOR UPDATE',
      [serviceRecordId]
    );

    if (recordResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.volunteers.serviceRecordNotFound };
    }

    const record = recordResult.rows[0] as ServiceRecord;

    if (record.volunteer_id !== volunteerId) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.corrections.notRecordOwner };
    }

    if (record.is_no_show) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.corrections.noShowNotAllowed };
    }

    const existingResult = await client.query(
      'SELECT id, status FROM record_corrections WHERE service_record_id = $1 LIMIT 1',
      [serviceRecordId]
    );

    if (existingResult.rows.length > 0) {
      await client.query('ROLLBACK');
      const existing = existingResult.rows[0];
      if (existing.status === 'pending') {
        return { success: false, error: messages.corrections.pendingExists };
      }
      return { success: false, error: messages.corrections.alreadySubmitted };
    }

    const nextDuration = input.corrected_duration_hours ?? Number(record.duration_hours);
    const nextType = input.corrected_service_type ?? record.service_type;
    const nextRating = input.corrected_rating ?? record.rating;

    if (
      nextDuration === Number(record.duration_hours) &&
      nextType === record.service_type &&
      nextRating === record.rating
    ) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.corrections.correctedValueSame };
    }

    const insertResult = await client.query(
      `INSERT INTO record_corrections
         (service_record_id, volunteer_id, corrected_duration_hours, corrected_service_type,
          corrected_rating, reason, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending')
       RETURNING *`,
      [
        serviceRecordId,
        volunteerId,
        input.corrected_duration_hours ?? null,
        input.corrected_service_type ?? null,
        input.corrected_rating ?? null,
        input.reason,
      ]
    );

    await client.query('COMMIT');

    return { success: true, data: insertResult.rows[0] as RecordCorrection };
  } catch (error) {
    await client.query('ROLLBACK');
    if (isUniqueViolation(error)) {
      return { success: false, error: messages.corrections.pendingExists };
    }
    logger.error(messages.corrections.createFailed, error);
    return { success: false, error: messages.corrections.createFailed };
  } finally {
    client.release();
  }
};

export interface ApproveCorrectionResult {
  correction: RecordCorrection;
  record: ServiceRecord;
  oldPointsEarned: number;
  newPointsEarned: number;
  pointsChange: number;
  oldTotalPoints: number;
  newTotalPoints: number;
  oldLevel: number;
  newLevel: number;
  badgesAwarded: unknown[];
  badgesRemoved: unknown[];
  creditScore: number;
  creditChange: number;
}

/**
 * 管理员批准纠错：在单事务内完成
 * 1) 条件 UPDATE 把申请从 pending 置为 approved（并发批准只有一方生效）
 * 2) 锁定并更正服务记录
 * 3) 以积分差额重算志愿者积分、等级
 * 4) 按新等级对齐徽章（升级补授、降级撤销）
 * 5) 重算信用分并写信用明细
 * 任一步失败整体回滚，不留下半更新。
 */
export const approveCorrection = async (
  correctionId: string,
  adminId: string,
  reviewNote: string
): Promise<ApiResponse<ApproveCorrectionResult>> => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    // 与其它事务（如管理员删除记录）发生锁竞争时快速失败回滚，避免长阻塞与死锁
    await client.query('SET LOCAL lock_timeout = \'3000\'');
    const claimResult = await client.query(
      `UPDATE record_corrections
       SET status = 'approved', review_note = $1, reviewed_by = $2, reviewed_at = CURRENT_TIMESTAMP
       WHERE id = $3 AND status = 'pending'
       RETURNING *`,
      [reviewNote, adminId, correctionId]
    );

    if (claimResult.rows.length === 0) {
      await client.query('ROLLBACK');
      const exists = await client.query(
        'SELECT status FROM record_corrections WHERE id = $1',
        [correctionId]
      );
      if (exists.rows.length === 0) {
        return { success: false, error: messages.corrections.notFound };
      }
      return { success: false, error: messages.corrections.alreadyReviewed };
    }

    const correction = claimResult.rows[0] as RecordCorrection;

    const recordResult = await client.query(
      'SELECT * FROM service_records WHERE id = $1 FOR UPDATE',
      [correction.service_record_id]
    );

    if (recordResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.volunteers.serviceRecordNotFound };
    }

    const record = recordResult.rows[0] as ServiceRecord;

    const volunteerResult = await client.query(
      'SELECT * FROM volunteers WHERE id = $1 FOR UPDATE',
      [record.volunteer_id]
    );

    if (volunteerResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.volunteers.notFound };
    }

    const volunteer = volunteerResult.rows[0] as Volunteer;

    const oldDuration = Number(record.duration_hours);
    const oldType = record.service_type;
    const oldRating = record.rating;
    const oldPointsEarned = record.points_earned || 0;

    const newDuration = correction.corrected_duration_hours !== null && correction.corrected_duration_hours !== undefined
      ? Number(correction.corrected_duration_hours)
      : oldDuration;
    const newType = correction.corrected_service_type ?? oldType;
    const newRating = correction.corrected_rating ?? oldRating;
    const newPointsEarned = calculatePoints(newDuration, newType, newRating);
    const pointsChange = newPointsEarned - oldPointsEarned;

    await client.query(
      `UPDATE service_records
       SET service_type = $1,
           duration_hours = $2,
           rating = $3,
           points_earned = $4
       WHERE id = $5`,
      [newType, newDuration, newRating, newPointsEarned, record.id]
    );

    const oldTotalPoints = volunteer.total_points;
    const newTotalPoints = Math.max(0, oldTotalPoints + pointsChange);
    const oldLevel = volunteer.level;
    const newLevel = calculateLevel(newTotalPoints);

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
        `纠错批准重算积分: ${correction.reason}`,
        oldTotalPoints,
        newTotalPoints,
        record.id,
        'record_correction',
      ]
    );

    const badges = await reconcileBadgesWithClient(client, volunteer.id, newLevel);

    // 信用分基于更正后的最新记录重算，与积分明细在同一事务内落库
    const creditResult = await recalculateCreditScoreWithClient(client, volunteer.id);
    const creditChange = creditResult ? creditResult.changeAmount : 0;
    const creditAfter = creditResult ? creditResult.afterScore : volunteer.credit_score;

    if (creditResult && creditChange !== 0) {
      await logCreditChangeWithClient(
        client,
        volunteer.id,
        creditChange,
        '纠错批准-信用分重算',
        creditResult.beforeScore,
        creditResult.afterScore,
        correction.id,
        'record_correction'
      );
    }

    await client.query(
      `INSERT INTO admin_audit_logs (admin_id, action, target_type, target_id, old_value, new_value, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        adminId,
        'approve_correction',
        'record_correction',
        correction.id,
        {
          duration_hours: oldDuration,
          service_type: oldType,
          rating: oldRating,
          points_earned: oldPointsEarned,
          total_points: oldTotalPoints,
          level: oldLevel,
          credit_score: volunteer.credit_score,
        },
        {
          duration_hours: newDuration,
          service_type: newType,
          rating: newRating,
          points_earned: newPointsEarned,
          total_points: newTotalPoints,
          level: newLevel,
          credit_score: creditAfter,
          badges_awarded: badges.awarded.map(b => b.star_level),
          badges_removed: badges.removed.map(b => b.star_level),
        },
        reviewNote,
      ]
    );

    await client.query('COMMIT');

    return {
      success: true,
      message: messages.corrections.approved,
      data: {
        correction,
        record: { ...record, duration_hours: newDuration, service_type: newType, rating: newRating, points_earned: newPointsEarned },
        oldPointsEarned,
        newPointsEarned,
        pointsChange,
        oldTotalPoints,
        newTotalPoints,
        oldLevel,
        newLevel,
        badgesAwarded: badges.awarded,
        badgesRemoved: badges.removed,
        creditScore: creditAfter,
        creditChange,
      },
    };
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error(messages.corrections.approveFailed, error);
    return { success: false, error: messages.corrections.approveFailed };
  } finally {
    client.release();
  }
};

/**
 * 管理员驳回纠错：只变更申请状态，服务记录与全部统计保持原样。
 * 条件 UPDATE 保证与批准/重复驳回并发时最多只生效一次。
 */
export const rejectCorrection = async (
  correctionId: string,
  adminId: string,
  reviewNote: string
): Promise<ApiResponse<{ correction: RecordCorrection }>> => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const result = await client.query(
      `UPDATE record_corrections
       SET status = 'rejected', review_note = $1, reviewed_by = $2, reviewed_at = CURRENT_TIMESTAMP
       WHERE id = $3 AND status = 'pending'
       RETURNING *`,
      [reviewNote, adminId, correctionId]
    );

    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      const exists = await client.query(
        'SELECT status FROM record_corrections WHERE id = $1',
        [correctionId]
      );
      if (exists.rows.length === 0) {
        return { success: false, error: messages.corrections.notFound };
      }
      return { success: false, error: messages.corrections.alreadyReviewed };
    }

    const correction = result.rows[0] as RecordCorrection;

    await client.query(
      `INSERT INTO admin_audit_logs (admin_id, action, target_type, target_id, reason)
       VALUES ($1, $2, $3, $4, $5)`,
      [adminId, 'reject_correction', 'record_correction', correction.id, reviewNote]
    );

    await client.query('COMMIT');

    return {
      success: true,
      message: messages.corrections.rejected,
      data: { correction },
    };
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error(messages.corrections.rejectFailed, error);
    return { success: false, error: messages.corrections.rejectFailed };
  } finally {
    client.release();
  }
};

export const getCorrectionById = async (
  correctionId: string
): Promise<ApiResponse<RecordCorrection>> => {
  const client = await pool.connect();

  try {
    const result = await client.query(
      `SELECT c.*, sr.service_type AS record_service_type,
              sr.duration_hours AS record_duration_hours,
              sr.rating AS record_rating,
              sr.points_earned AS record_points_earned
       FROM record_corrections c
       JOIN service_records sr ON sr.id = c.service_record_id
       WHERE c.id = $1`,
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

export const getCorrections = async (
  page: number = 1,
  pageSize: number = 20,
  filters: { status?: string; volunteerId?: string; serviceRecordId?: string } = {}
): Promise<ApiResponse<any>> => {
  const client = await pool.connect();

  try {
    const offset = (page - 1) * pageSize;
    const where: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (filters.status) {
      where.push(`status = $${paramIndex++}`);
      params.push(filters.status);
    }
    if (filters.volunteerId) {
      where.push(`volunteer_id = $${paramIndex++}`);
      params.push(filters.volunteerId);
    }
    if (filters.serviceRecordId) {
      where.push(`service_record_id = $${paramIndex++}`);
      params.push(filters.serviceRecordId);
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const countResult = await client.query(
      `SELECT COUNT(*) as total FROM record_corrections ${whereClause}`,
      params
    );

    const listResult = await client.query(
      `SELECT * FROM record_corrections
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, pageSize, offset]
    );

    return {
      success: true,
      data: {
        corrections: listResult.rows,
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
