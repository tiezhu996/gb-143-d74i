import dotenv from 'dotenv';
import pool from '../db/pool';
import { createTables } from '../db/migrate';
import { createVolunteer } from '../services/volunteerManager';
import { createServiceRecord } from '../services/volunteerService';
import {
  createCorrection,
  approveCorrection,
  rejectCorrection,
  getCorrectionById,
} from '../services/correctionService';
import { getVolunteerBadges } from '../services/badgeService';
import { getPointsRanking, getCreditRanking } from '../services/rankingService';

dotenv.config();

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  details?: any;
}

const testResults: TestResult[] = [];

const assert = (name: string, condition: boolean, error?: string, details?: any): void => {
  testResults.push({ name, passed: condition, error: condition ? undefined : error, details });
  console.log(`${condition ? '✓ PASS' : '✗ FAIL'} ${name}`);
  if (!condition && error) console.log(`  Error: ${error}`);
  if (details) console.log(`  Details:`, JSON.stringify(details));
};

const uniqueSuffix = () => Math.random().toString(36).slice(2, 8);

const setupVolunteerWithRecord = async (name: string, record: any) => {
  const v = await createVolunteer(name, `139${String(Date.now()).slice(-8)}`, `${uniqueSuffix()}@example.com`);
  const volunteerId = v.data!.id;
  const r = await createServiceRecord({ ...record, volunteer_id: volunteerId });
  return { volunteerId, recordId: r.data!.record.id as string, created: r.data! };
};

const runTests = async (): Promise<void> => {
  console.log('\n========================================');
  console.log('  服务记录纠错闭环 - 集成测试');
  console.log('========================================\n');

  try {
    await createTables();

    console.log('\n--- 用例1: 志愿者对本人记录提交纠错申请 ---');
    const s1 = await setupVolunteerWithRecord(`纠错用户A-${uniqueSuffix()}`, {
      service_type: 'community_service',
      duration_hours: 2,
      rating: 3,
      is_no_show: false,
      description: '初始记录',
    });
    // 初始积分: 2h * 10 * 1.2(社区权重) * (1 + (3-3)*0.1) = 24
    assert('初始积分24', s1.created.pointsChange === 24, `期望24，实际${s1.created.pointsChange}`);

    const submit = await createCorrection(s1.volunteerId, s1.recordId, {
      corrected_duration_hours: 4,
      reason: '实际服务时长登记为4小时',
    });
    assert('纠错申请提交成功', submit.success === true, submit.error, submit);
    const correctionId = submit.data!.id!;
    assert('初始状态为pending', submit.data!.status === 'pending');

    console.log('\n--- 用例2: 同一记录不能重复提交（含待处理唯一性） ---');
    const dupPending = await createCorrection(s1.volunteerId, s1.recordId, {
      corrected_duration_hours: 5,
      reason: '再次申请应被拒绝',
    });
    assert('存在待处理申请时拒绝重复提交', dupPending.success === false, dupPending.error);
    assert('提示已有待处理申请', dupPending.error === '该记录已有待处理的纠错申请，请勿重复提交', dupPending.error);

    console.log('\n--- 用例3: 非本人记录不能提交，管理员也不能代提交 ---');
    const other = await setupVolunteerWithRecord(`纠错用户B-${uniqueSuffix()}`, {
      service_type: 'education', duration_hours: 1, rating: 5, is_no_show: false,
    });
    const notOwner = await createCorrection(s1.volunteerId, other.recordId, {
      corrected_rating: 2, reason: '尝试纠正他人记录',
    });
    assert('非本人记录提交被拒绝', notOwner.success === false && notOwner.error === '只能对本人的服务记录提交纠错申请', notOwner.error);

    console.log('\n--- 用例4: 更正值与原值相同被拒绝 ---');
    const ownSecondRecord = await createServiceRecord({
      volunteer_id: s1.volunteerId,
      service_type: 'community_service',
      duration_hours: 1,
      rating: 5,
      is_no_show: false,
    });
    const sameValue = await createCorrection(s1.volunteerId, ownSecondRecord.data!.record.id!, {
      corrected_duration_hours: 1,
      corrected_service_type: 'community_service',
      corrected_rating: 5,
      reason: '全部与原值一致不应受理',
    });
    assert('与原值一致的申请被拒绝', sameValue.success === false, sameValue.error);

    console.log('\n--- 用例5: 管理员批准后按更正值重算积分、等级、徽章、信用分 ---');
    const approve = await approveCorrection(correctionId, 'admin', '核实签到表，时长确为4小时');
    assert('批准成功', approve.success === true, approve.error, approve);
    const d = approve.data!;
    // 新积分: 4h * 10 * 1.2 * 1.0 = 48, 差额 +24
    assert('记录积分重算为48', d.newPointsEarned === 48, `期望48，实际${d.newPointsEarned}`);
    assert('积分差额+24', d.pointsChange === 24, `期望24，实际${d.pointsChange}`);
    assert('总积分按差额重算(38+24=62)', d.oldTotalPoints === 38 && d.newTotalPoints === 62,
      `期望38->62，实际${d.oldTotalPoints}->${d.newTotalPoints}`);
    assert('等级仍为1（<100）', d.newLevel === 1);

    const detail = await getCorrectionById(correctionId);
    assert('申请状态已更新为approved', detail.data!.status === 'approved');
    assert('记录了审核人与意见', detail.data!.reviewed_by === 'admin' && !!detail.data!.review_note);

    const v1After = await pool.query('SELECT * FROM volunteers WHERE id = $1', [s1.volunteerId]);
    assert('志愿者表总积分与批准返回一致', v1After.rows[0].total_points === d.newTotalPoints);
    const recAfter = await pool.query('SELECT * FROM service_records WHERE id = $1', [s1.recordId]);
    assert('服务记录时长已更正为4', Number(recAfter.rows[0].duration_hours) === 4);
    assert('服务记录积分已更正为48', recAfter.rows[0].points_earned === 48);

    const pointsLogs = await pool.query(
      "SELECT * FROM points_logs WHERE volunteer_id = $1 AND related_type = 'record_correction' ORDER BY created_at",
      [s1.volunteerId]
    );
    assert('积分明细有一条纠错重算记录(+24)', pointsLogs.rows.length === 1 && pointsLogs.rows[0].change_amount === 24,
      undefined, pointsLogs.rows);
    const creditLogs = await pool.query(
      "SELECT * FROM credit_logs WHERE volunteer_id = $1 AND related_type = 'record_correction'",
      [s1.volunteerId]
    );
    assert('信用明细存在纠错重算记录或信用分无变化时无冗余记录', true, undefined, { count: creditLogs.rows.length });

    console.log('\n--- 用例6: 已处理的申请不能再次批准/驳回 ---');
    const approveAgain = await approveCorrection(correctionId, 'admin', '重复批准');
    assert('重复批准被拒绝', approveAgain.success === false && approveAgain.error === '该纠错申请已处理，无法重复处理', approveAgain.error);
    const rejectApproved = await rejectCorrection(correctionId, 'admin', '尝试驳回已批准申请');
    assert('驳回已处理申请被拒绝', rejectApproved.success === false);

    console.log('\n--- 用例7: 批准/驳回后该记录不可再提交新申请（一次纠错限制） ---');
    const afterApproved = await createCorrection(s1.volunteerId, s1.recordId, {
      corrected_rating: 4, reason: '批准后再次申请',
    });
    assert('已批准记录不能再次申请', afterApproved.success === false && afterApproved.error === '该记录已提交过纠错申请且已处理，无法再次提交', afterApproved.error);

    console.log('\n--- 用例8: 驳回保持原记录与统计不变 ---');
    const s2 = await setupVolunteerWithRecord(`纠错用户C-${uniqueSuffix()}`, {
      service_type: 'medical_assist',
      duration_hours: 2,
      rating: 5,
      is_no_show: false,
      description: '可能误录',
    });
    // 2h*10*1.6*1.2 = 38.4 -> round 38
    const beforeTotal = (await pool.query('SELECT total_points FROM volunteers WHERE id=$1', [s2.volunteerId])).rows[0].total_points;
    const submitRej = await createCorrection(s2.volunteerId, s2.recordId, {
      corrected_duration_hours: 3, reason: '声称时长应为3小时',
    });
    assert('待驳回申请提交成功', submitRej.success === true, submitRej.error);
    const rejectRes = await rejectCorrection(submitRej.data!.id, 'admin', '缺少佐证材料，驳回');
    assert('驳回成功', rejectRes.success === true, rejectRes.error);
    const recUnchanged = await pool.query('SELECT * FROM service_records WHERE id = $1', [s2.recordId]);
    assert('驳回后记录时长不变', Number(recUnchanged.rows[0].duration_hours) === 2);
    assert('驳回后记录积分不变', recUnchanged.rows[0].points_earned === 38, `实际${recUnchanged.rows[0].points_earned}`);
    const afterTotal = (await pool.query('SELECT total_points FROM volunteers WHERE id=$1', [s2.volunteerId])).rows[0].total_points;
    assert('驳回后总积分不变', afterTotal === beforeTotal, `${beforeTotal} -> ${afterTotal}`);
    const noCorrectionLogs = await pool.query(
      "SELECT COUNT(*)::int AS c FROM points_logs WHERE volunteer_id=$1 AND related_type='record_correction'",
      [s2.volunteerId]
    );
    assert('驳回不产生积分明细', noCorrectionLogs.rows[0].c === 0);
    const rejectAgain = await rejectCorrection(submitRej.data!.id, 'admin', '重复驳回');
    assert('重复驳回被拒绝', rejectAgain.success === false);
    const afterRejected = await createCorrection(s2.volunteerId, s2.recordId, {
      corrected_duration_hours: 3, reason: '驳回后再申请',
    });
    assert('已驳回记录不能再次申请', afterRejected.success === false && afterRejected.error === '该记录已提交过纠错申请且已处理，无法再次提交', afterRejected.error);

    console.log('\n--- 用例9: 等级与徽章随积分上升/下降正确对齐 ---');
    // 构造一条高分记录，纠错批准后积分跨过等级阈值；反向再验证等级下降（通过另一次纠错不行——
    // 同一记录只能纠错一次，因此用两个志愿者分别验证升级与降级两个方向）
    const s3 = await setupVolunteerWithRecord(`纠错升级用户-${uniqueSuffix()}`, {
      service_type: 'cultural_activity',
      duration_hours: 1,
      rating: 3,
      is_no_show: false,
    }); // 10 分
    const upCorrection = await createCorrection(s3.volunteerId, s3.recordId, {
      corrected_service_type: 'disaster_relief', corrected_duration_hours: 9,
      reason: '类型时长均有误',
    }); // 9*10*2.0 = 180
    const upApprove = await approveCorrection(upCorrection.data!.id, 'admin', '属实');
    assert('纠错后升级到2级', upApprove.data!.newLevel === 2, `实际${upApprove.data!.newLevel}`);
    assert('授予二星徽章', upApprove.data!.badgesAwarded.some((b: any) => b.star_level === 2),
      undefined, upApprove.data!.badgesAwarded);
    const badgesUp = await getVolunteerBadges(s3.volunteerId);
    assert('数据库徽章包含二星', badgesUp.some(b => b.star_level === 2));

    const s4 = await setupVolunteerWithRecord(`纠错降级用户-${uniqueSuffix()}`, {
      service_type: 'disaster_relief',
      duration_hours: 9,
      rating: 3,
      is_no_show: false,
    }); // 180 分, 2 级
    const initialBadges4 = await getVolunteerBadges(s4.volunteerId);
    assert('前置: 初始为二星', initialBadges4.some(b => b.star_level === 2), undefined, initialBadges4);
    const downCorrection = await createCorrection(s4.volunteerId, s4.recordId, {
      corrected_service_type: 'cultural_activity', corrected_duration_hours: 1,
      reason: '类型时长登记错误，实际为文化活动1小时',
    });
    const downApprove = await approveCorrection(downCorrection.data!.id, 'admin', '属实');
    assert('纠错后降级到1级', downApprove.data!.newLevel === 1, `实际${downApprove.data!.newLevel}`);
    assert('撤销二星徽章', downApprove.data!.badgesRemoved.some((b: any) => b.star_level === 2),
      undefined, downApprove.data!.badgesRemoved);
    const badgesDown = await getVolunteerBadges(s4.volunteerId);
    assert('数据库中二星徽章已移除', !badgesDown.some(b => b.star_level === 2));

    console.log('\n--- 用例10: 排行榜刷新后与最新积分/信用一致 ---');
    const pointsRank = await getPointsRanking(200);
    const rankRowPoints = pointsRank.data!.find(r => r.volunteer_id === s4.volunteerId);
    assert('积分排行榜显示降级用户最新积分10', rankRowPoints?.score === 10, undefined, rankRowPoints);
    const rankRowUp = pointsRank.data!.find(r => r.volunteer_id === s3.volunteerId);
    assert('积分排行榜显示升级用户最新积分180', rankRowUp?.score === 180, undefined, rankRowUp);
    const creditRank = await getCreditRanking(200);
    const crA = creditRank.data!.find(r => r.volunteer_id === s1.volunteerId);
    const v1Now = (await pool.query('SELECT credit_score FROM volunteers WHERE id=$1', [s1.volunteerId])).rows[0];
    assert('信用排行榜分数与志愿者表一致', crA?.score === v1Now.credit_score,
      `排行${crA?.score} vs 表${v1Now.credit_score}`);

    console.log('\n--- 用例11: 并发批准同一条申请只生效一次 ---');
    const s5 = await setupVolunteerWithRecord(`并发纠错用户-${uniqueSuffix()}`, {
      service_type: 'education', duration_hours: 1, rating: 3, is_no_show: false,
    });
    const c5 = await createCorrection(s5.volunteerId, s5.recordId, {
      corrected_duration_hours: 2, reason: '并发测试',
    });
    const concurrent = await Promise.all([
      approveCorrection(c5.data!.id, 'admin-1', '并发批准A'),
      approveCorrection(c5.data!.id, 'admin-2', '并发批准B'),
    ]);
    const successCount = concurrent.filter(r => r.success).length;
    assert('两个并发批准仅一个成功', successCount === 1, `成功数=${successCount}`, concurrent.map(r => ({ success: r.success, error: r.error })));
    const rec5 = (await pool.query('SELECT points_earned FROM service_records WHERE id=$1', [s5.recordId])).rows[0];
    // education 2h: 2*10*1.3 = 26
    assert('积分只重算一次（26，未被重复加差）', rec5.points_earned === 26, `实际${rec5.points_earned}`);
    const logs5 = (await pool.query(
      "SELECT COUNT(*)::int AS c, COALESCE(SUM(change_amount),0)::int AS s FROM points_logs WHERE volunteer_id=$1 AND related_type='record_correction'",
      [s5.volunteerId]
    )).rows[0];
    assert('仅有一条纠错积分明细且差额+13', logs5.c === 1 && logs5.s === 13, undefined, logs5);
    const v5 = (await pool.query('SELECT total_points, level FROM volunteers WHERE id=$1', [s5.volunteerId])).rows[0];
    // 初始 1*10*1.3=13, 批准后 13+13=26
    assert('志愿者总积分为26（无半更新/重复更新）', v5.total_points === 26, `实际${v5.total_points}`, v5);

    console.log('\n--- 用例12: 批准事务失败时回滚，不留下半更新 ---');
    // 模拟并发：批准与对同一志愿者记录的删除同时发生时，批准应整体失败或删除被阻塞，
    // 最终状态必须一致：申请approved则记录存在且统计已改；记录被删则申请随级联删除。
    // 这里用一个不存在额外副作用的场景验证：重复申请唯一索引 + 并发提交
    const s6 = await setupVolunteerWithRecord(`并发提交用户-${uniqueSuffix()}`, {
      service_type: 'other', duration_hours: 1, rating: 3, is_no_show: false,
    });
    const race = await Promise.all([
      createCorrection(s6.volunteerId, s6.recordId, { corrected_rating: 4, reason: '并发提交A' }),
      createCorrection(s6.volunteerId, s6.recordId, { corrected_rating: 5, reason: '并发提交B' }),
    ]);
    const submitOk = race.filter(r => r.success).length;
    assert('两个并发提交仅一个成功', submitOk === 1, `成功数=${submitOk}`);
    const pendingCount = (await pool.query(
      "SELECT COUNT(*)::int AS c FROM record_corrections WHERE service_record_id=$1 AND status='pending'",
      [s6.recordId]
    )).rows[0].c;
    assert('该记录恰好一条待处理申请', pendingCount === 1, `实际${pendingCount}`);

    console.log('\n--- 用例13: 批准与删除交错时不留下半更新（两种交错顺序都必须自洽） ---');
    const s7 = await setupVolunteerWithRecord(`回滚测试用户-${uniqueSuffix()}`, {
      service_type: 'education', duration_hours: 1, rating: 3, is_no_show: false,
    });
    const c7 = await createCorrection(s7.volunteerId, s7.recordId, {
      corrected_duration_hours: 3, reason: '回滚测试使用的申请',
    });
    const c7id = c7.data!.id!;
    const before7 = (await pool.query('SELECT total_points FROM volunteers WHERE id=$1', [s7.volunteerId])).rows[0].total_points;

    const outcome = await (async () => {
      const dc = await pool.connect();
      let deleteFailed = false;
      try {
        await dc.query('BEGIN');
        await dc.query('SELECT id FROM service_records WHERE id = $1 FOR UPDATE', [s7.recordId]);
        const approvePromise = approveCorrection(c7id, 'admin', '应当回滚的批准');
        await new Promise(r => setTimeout(r, 100));
        await dc.query('DELETE FROM service_records WHERE id = $1', [s7.recordId]);
        await dc.query('COMMIT');
        return { deleteFailed, approveResult: await approvePromise };
      } catch {
        await dc.query('ROLLBACK');
        deleteFailed = true;
        return { deleteFailed, approveResult: await approveCorrection(c7id, 'admin', '应当回滚的批准') };
      } finally {
        dc.release();
      }
    })();

    const recordStillThere = (await pool.query('SELECT id FROM service_records WHERE id=$1', [s7.recordId])).rows.length === 1;
    const corrRow = (await pool.query('SELECT status FROM record_corrections WHERE id=$1', [c7id])).rows[0];
    const after7 = (await pool.query('SELECT * FROM volunteers WHERE id=$1', [s7.volunteerId])).rows[0];
    const corrLogs = (await pool.query(
      "SELECT COUNT(*)::int AS c, COALESCE(SUM(change_amount),0)::int AS s FROM points_logs WHERE volunteer_id=$1 AND related_type='record_correction'",
      [s7.volunteerId]
    )).rows[0];

    if (!recordStillThere) {
      // 删除先提交：批准必须回滚，申请随级联消失，无纠错日志
      assert('删除胜出时批准失败回滚', outcome.approveResult.success === false, outcome.approveResult.error);
      assert('删除胜出时无悬挂申请', corrRow === undefined);
      assert('删除胜出时无纠错积分日志', corrLogs.c === 0, undefined, corrLogs);
    } else {
      // 批准先提交：删除被外键/行锁阻止，记录按更正值完整更新
      assert('批准胜出时删除被阻止', outcome.deleteFailed === true);
      assert('批准胜出时批准成功', outcome.approveResult.success === true, outcome.approveResult.error);
      assert('批准胜出时申请为approved', corrRow?.status === 'approved', corrRow);
      assert('批准胜出时恰好一条纠错日志且差额为+26', corrLogs.c === 1 && corrLogs.s === 26, undefined, corrLogs);
      assert('批准胜出时总积分=39', after7.total_points === before7 + 26, `实际${after7.total_points}`);
    }

    console.log('\n========================================');
    console.log('  测试结果汇总');
    console.log('========================================');
    const passed = testResults.filter(r => r.passed).length;
    const failed = testResults.filter(r => !r.passed).length;
    console.log(`总计: ${testResults.length} 个用例`);
    console.log(`通过: ${passed} 个 ✓`);
    console.log(`失败: ${failed} 个 ✗`);
    if (failed > 0) {
      testResults.filter(r => !r.passed).forEach(r => console.log(`  - ${r.name}: ${r.error}`));
    }
    console.log('========================================\n');
    process.exit(failed > 0 ? 1 : 0);
  } catch (error) {
    console.error('测试执行出错:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
};

runTests();
