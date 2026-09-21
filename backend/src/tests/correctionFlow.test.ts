import dotenv from 'dotenv';
import pool from '../db/pool';
import { createTables } from '../db/migrate';
import { createVolunteer, getVolunteerById } from '../services/volunteerManager';
import { createServiceRecord } from '../services/volunteerService';
import { getVolunteerBadges } from '../services/badgeService';
import {
  createCorrectionRequest,
  handleCorrectionRequest,
  getCorrectionRequests,
  getCorrectionRequestById,
} from '../services/correctionService';
import { getPointsRanking } from '../services/rankingService';

dotenv.config();

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  details?: any;
}

const testResults: TestResult[] = [];

const assert = (name: string, condition: boolean, error?: string, details?: any): void => {
  testResults.push({
    name,
    passed: condition,
    error: condition ? undefined : error,
    details,
  });
  const status = condition ? '✓ PASS' : '✗ FAIL';
  console.log(`${status} ${name}`);
  if (!condition && error) {
    console.log(`  Error: ${error}`);
  }
  if (details !== undefined) {
    console.log(`  Details:`, JSON.stringify(details));
  }
};

const queryOne = async (sql: string, params: any[] = []) => {
  const result = await pool.query(sql, params);
  return result.rows;
};

const runTests = async (): Promise<void> => {
  console.log('\n========================================');
  console.log('  志愿者积分与信用评估系统 - 验证用例');
  console.log('  测试场景: 服务记录纠错闭环');
  console.log('========================================\n');

  try {
    console.log('初始化数据库...');
    await createTables();

    const mkVolunteer = async (label: string) => {
      const r = await createVolunteer(label, undefined, `${label}@example.com`);
      if (!r.success || !r.data?.id) {
        throw new Error(`志愿者创建失败: ${r.error}`);
      }
      return r.data.id;
    };

    console.log('\n--- 用例1: 志愿者提交纠错申请并由管理员批准（时长更正） ---');
    const volA = await mkVolunteer('纠错测试-甲');
    const recA = await createServiceRecord({
      volunteer_id: volA,
      service_type: 'community_service',
      duration_hours: 2,
      rating: 5,
    });
    assert('创建初始服务记录成功', recA.success === true, recA.error);
    const recordAId: string = recA.data!.record.id!;
    // 2h * 10 * 1.2 权重 * 1.2 评分加成 ≈ 29
    assert('初始积分为29', recA.data!.newTotalPoints === 29,
      `期望29，实际${recA.data!.newTotalPoints}`);

    const corrA = await createCorrectionRequest(recordAId, volA, {
      corrected_duration_hours: 4,
      reason: '实际服务时长为4小时，登记为2小时',
    });
    assert('纠错申请提交成功', corrA.success === true, corrA.error, corrA);
    assert('申请初始状态为pending', corrA.data?.status === 'pending');
    assert('申请保存了原始时长', Number(corrA.data?.original_duration_hours) === 2);
    assert('申请保存了更正时长', Number(corrA.data?.corrected_duration_hours) === 4);
    const corrAId: string = corrA.data!.id;

    console.log('\n--- 用例2: 同一记录只能有一条待处理申请，且终身只能提交一次 ---');
    const corrAAgain = await createCorrectionRequest(recordAId, volA, {
      corrected_duration_hours: 5,
      reason: '再次尝试提交纠错',
    });
    assert('待处理期间重复提交被拒绝', corrAAgain.success === false
      && corrAAgain.error === '该记录已有待处理的纠错申请', corrAAgain.error);

    const approveA = await handleCorrectionRequest(corrAId, 'approve', 'admin-1');
    assert('管理员批准成功', approveA.success === true, approveA.error, approveA);
    // 4h * 10 * 1.2 * 1.2 = 57.6 → 58
    assert('批准后积分按更正值重算为58', approveA.data!.newTotalPoints === 58,
      `期望58，实际${approveA.data!.newTotalPoints}`);
    assert('积分差额为+29', approveA.data!.pointsChange === 29);

    const corrARetry = await createCorrectionRequest(recordAId, volA, {
      corrected_duration_hours: 6,
      reason: '批准后再次尝试',
    });
    assert('已处理过的记录不能再次提交', corrARetry.success === false
      && corrARetry.error === '该记录已提交过纠错申请，每条记录只能提交一次', corrARetry.error);

    const doubleApprove = await handleCorrectionRequest(corrAId, 'approve', 'admin-1');
    assert('批准操作不可重复执行', doubleApprove.success === false
      && doubleApprove.error === '该纠错申请已处理', doubleApprove.error);
    const doubleReject = await handleCorrectionRequest(corrAId, 'reject', 'admin-1');
    assert('已批准的申请不能再驳回', doubleReject.success === false, doubleReject.error);

    console.log('\n--- 用例3: 只能对本人记录纠错 ---');
    const volB = await mkVolunteer('纠错测试-乙');
    const recB = await createServiceRecord({
      volunteer_id: volB,
      service_type: 'education',
      duration_hours: 2,
      rating: 4,
    });
    const recordBId: string = recB.data!.record.id!;
    const notOwner = await createCorrectionRequest(recordBId, volA, {
      corrected_rating: 2,
      reason: '尝试更正他人的记录',
    });
    assert('非本人记录提交被拒绝', notOwner.success === false
      && notOwner.error === '只能对本人的服务记录提交纠错申请', notOwner.error);
    const missingRecord = await createCorrectionRequest('00000000-0000-0000-0000-000000000000', volA, {
      corrected_rating: 2,
      reason: '不存在的记录',
    });
    assert('不存在的记录返回错误', missingRecord.success === false, missingRecord.error);

    console.log('\n--- 用例4: 批准后积分明细、记录、排行榜一致 ---');
    const recordARows = await queryOne('SELECT * FROM service_records WHERE id = $1', [recordAId]);
    assert('记录时长已更新为4', Number(recordARows[0].duration_hours) === 4);
    assert('记录积分贡献已重算为58', Number(recordARows[0].points_earned) === 58);

    const volARow = await getVolunteerById(volA);
    assert('志愿者表总积分与记录一致(58)', volARow.data?.total_points === 58);

    const pointsLogsA = await queryOne(
      "SELECT * FROM points_logs WHERE volunteer_id = $1 ORDER BY created_at, change_amount",
      [volA]
    );
    const pointsSum = pointsLogsA.reduce((s, l) => s + Number(l.change_amount), 0);
    assert('积分明细累加等于总积分', pointsSum === 58, `明细累加=${pointsSum}`);
    assert('纠错积分日志已写入', pointsLogsA.some(l => l.related_type === 'correction'
      && Number(l.change_amount) === 29 && l.related_id === recordAId));

    const creditLogsA = await queryOne(
      'SELECT * FROM credit_logs WHERE volunteer_id = $1 ORDER BY created_at',
      [volA]
    );
    const creditSum = 100 + creditLogsA.reduce((s, l) => s + Number(l.change_amount), 0);
    assert('信用明细累加等于当前信用分', creditSum === volARow.data?.credit_score,
      `明细推导=${creditSum}，实际=${volARow.data?.credit_score}`);

    const pointsRanking = await getPointsRanking(100);
    const rankRow = (pointsRanking.data as any[]).find(r => r.volunteer_id === volA);
    assert('排行榜积分已刷新为58', Number(rankRow?.score) === 58,
      `排行榜分数=${rankRow?.score}`);

    const correctionsListMine = await getCorrectionRequests(1, 20, { volunteerId: volA });
    assert('本人纠错列表可查', (correctionsListMine.data?.corrections?.length ?? 0) >= 1);
    assert('列表项关联志愿者姓名', correctionsListMine.data?.corrections[0]?.volunteer_name === '纠错测试-甲');
    const correctionDetail = await getCorrectionRequestById(corrAId);
    assert('纠错详情可查且状态为approved', correctionDetail.data?.status === 'approved');
    assert('详情记录处理人', correctionDetail.data?.handled_by === 'admin-1');

    console.log('\n--- 用例5: 评分/类型更正触发信用分与徽章重算 ---');
    const volC = await mkVolunteer('纠错测试-丙');
    const recC = await createServiceRecord({
      volunteer_id: volC,
      service_type: 'cultural_activity',
      duration_hours: 5,
      rating: 3,
    });
    const recordCId: string = recC.data!.record.id!;
    // 5h * 10 * 1.0 * 1.0 = 50
    assert('初始积分50', recC.data!.newTotalPoints === 50, `实际${recC.data!.newTotalPoints}`);
    const volCBefore = await getVolunteerById(volC);
    const creditBefore = volCBefore.data!.credit_score;
    assert('初始信用分为101', creditBefore === 101, `实际${creditBefore}`);

    const corrC = await createCorrectionRequest(recordCId, volC, {
      corrected_duration_hours: 10,
      corrected_rating: 5,
      reason: '时长与评分登记错误',
    });
    const corrCId: string = corrC.data!.id;
    const approveC = await handleCorrectionRequest(corrCId, 'approve', 'admin-2', '核实无误，同意更正');
    assert('批准成功', approveC.success === true, approveC.error);
    // 10h * 10 * 1.0 * 1.2 = 120
    assert('更正后积分120并升级到2级', approveC.data!.newTotalPoints === 120
      && approveC.data!.newLevel === 2 && approveC.data!.levelUp === true);
    assert('批准结果包含信用分变化', approveC.data!.creditChange !== 0);

    const badgesC = await getVolunteerBadges(volC);
    assert('二星徽章已补发', badgesC.some(b => b.star_level === 2),
      undefined, badgesC.map(b => b.star_level));

    const volCAfter = await getVolunteerById(volC);
    const creditLogsC = await queryOne('SELECT * FROM credit_logs WHERE volunteer_id = $1', [volC]);
    const creditCSum = 100 + creditLogsC.reduce((s, l) => s + Number(l.change_amount), 0);
    // 100 + 0.5(服务次数) + 30(评分加成) = 130.5 → 封顶 120
    assert('信用分封顶120且明细一致', volCAfter.data?.credit_score === 120
      && creditCSum === 120, `信用分=${volCAfter.data?.credit_score} 明细推导=${creditCSum}`);
    assert('纠错信用日志已写入', creditLogsC.some(l => l.related_type === 'correction'));

    const cRecord = await queryOne('SELECT * FROM service_records WHERE id = $1', [recordCId]);
    assert('记录评分已更新为5', Number(cRecord[0].rating) === 5);
    assert('记录时长已更新为10', Number(cRecord[0].duration_hours) === 10);

    console.log('\n--- 用例6: 驳回保持原记录与统计，不产生纠错明细 ---');
    const volD = await mkVolunteer('纠错测试-丁');
    const recD = await createServiceRecord({
      volunteer_id: volD,
      service_type: 'environmental',
      duration_hours: 3,
      rating: 4,
    });
    const recordDId: string = recD.data!.record.id!;
    const pointsBeforeReject = recD.data!.newTotalPoints;
    const corrD = await createCorrectionRequest(recordDId, volD, {
      corrected_rating: 1,
      reason: '声称评分应为1分（测试驳回）',
    });
    const corrDId: string = corrD.data!.id;
    const rejectD = await handleCorrectionRequest(corrDId, 'reject', 'admin-3', '查证后维持原评分');
    assert('驳回成功', rejectD.success === true, rejectD.error);
    assert('驳回返回保持原记录提示', rejectD.message === '纠错申请已驳回，原记录与统计保持不变');

    const dRecord = await queryOne('SELECT * FROM service_records WHERE id = $1', [recordDId]);
    assert('驳回后记录评分不变', Number(dRecord[0].rating) === 4);
    assert('驳回后记录积分不变', Number(dRecord[0].points_earned) === pointsBeforeReject);
    const dLogs = await queryOne(
      "SELECT COUNT(*)::int AS c FROM points_logs WHERE volunteer_id = $1 AND related_type = 'correction'",
      [volD]
    );
    assert('驳回未写入纠错积分日志', dLogs[0].c === 0);
    const dCreditLogs = await queryOne(
      "SELECT COUNT(*)::int AS c FROM credit_logs WHERE volunteer_id = $1 AND related_type = 'correction'",
      [volD]
    );
    assert('驳回未写入纠错信用日志', dCreditLogs[0].c === 0);
    const dAfter = await getVolunteerById(volD);
    assert('驳回后总积分不变', dAfter.data?.total_points === pointsBeforeReject);
    assert('驳回后可查询到驳回结论', (await getCorrectionRequestById(corrDId)).data?.status === 'rejected');

    console.log('\n--- 用例7: 并发审批只生效一次，无半更新 ---');
    const volE = await mkVolunteer('纠错测试-戊');
    const recE = await createServiceRecord({
      volunteer_id: volE,
      service_type: 'education',
      duration_hours: 2,
      rating: 4,
    });
    const recordEId: string = recE.data!.record.id!;
    const corrE = await createCorrectionRequest(recordEId, volE, {
      corrected_duration_hours: 3,
      reason: '并发审批测试',
    });
    const corrEId: string = corrE.data!.id;
    const [ap1, ap2] = await Promise.all([
      handleCorrectionRequest(corrEId, 'approve', 'admin-x'),
      handleCorrectionRequest(corrEId, 'approve', 'admin-y'),
    ]);
    const successCount = [ap1, ap2].filter(r => r.success).length;
    assert('两个并发批准只有一个成功', successCount === 1,
      `成功数=${successCount}`, { ap1: ap1.success, ap2: ap2.success });

    const eCorrRows = await queryOne('SELECT status FROM correction_requests WHERE id = $1', [corrEId]);
    assert('申请最终状态为approved', eCorrRows[0].status === 'approved');
    const eCorrPointLogs = await queryOne(
      "SELECT COUNT(*)::int AS c FROM points_logs WHERE volunteer_id = $1 AND related_type = 'correction'",
      [volE]
    );
    assert('纠错积分日志只有一条', eCorrPointLogs[0].c === 1, `实际${eCorrPointLogs[0].c}`);
    const eVol = await getVolunteerById(volE);
    const eLogs = await queryOne('SELECT * FROM points_logs WHERE volunteer_id = $1', [volE]);
    const eSum = eLogs.reduce((s, l) => s + Number(l.change_amount), 0);
    assert('积分合计与志愿者总积分一致（无半更新）', eSum === eVol.data?.total_points,
      `明细=${eSum} 总积分=${eVol.data?.total_points}`);

    console.log('\n--- 用例8: 并发提交只产生一条申请 ---');
    const volF = await mkVolunteer('纠错测试-己');
    const recF = await createServiceRecord({
      volunteer_id: volF,
      service_type: 'other',
      duration_hours: 1,
      rating: 5,
    });
    const recordFId: string = recF.data!.record.id!;
    const [s1, s2] = await Promise.all([
      createCorrectionRequest(recordFId, volF, { corrected_duration_hours: 2, reason: '并发提交一' }),
      createCorrectionRequest(recordFId, volF, { corrected_duration_hours: 3, reason: '并发提交二' }),
    ]);
    const submitSuccess = [s1, s2].filter(r => r.success).length;
    assert('两个并发提交只有一个成功', submitSuccess === 1,
      `成功数=${submitSuccess}`);
    const fRows = await queryOne('SELECT COUNT(*)::int AS c FROM correction_requests WHERE record_id = $1', [recordFId]);
    assert('数据库中只有一条申请', fRows[0].c === 1, `实际${fRows[0].c}`);

    console.log('\n--- 用例9: 管理员可按状态筛选全部申请 ---');
    const pendingList = await getCorrectionRequests(1, 50, { status: 'pending' });
    assert('待处理列表可查', pendingList.success && pendingList.data.pagination.total >= 1);
    assert('待处理列表不含已处理项',
      (pendingList.data.corrections as any[]).every(c => c.status === 'pending'));
    const approvedList = await getCorrectionRequests(1, 50, { status: 'approved' });
    assert('已批准列表不含其他状态',
      (approvedList.data.corrections as any[]).every(c => c.status === 'approved'));

    console.log('\n========================================');
    console.log('  测试结果汇总');
    console.log('========================================');
    const passed = testResults.filter(r => r.passed).length;
    const failed = testResults.filter(r => !r.passed).length;
    console.log(`总计: ${testResults.length} 个用例`);
    console.log(`通过: ${passed} 个 ✓`);
    console.log(`失败: ${failed} 个 ✗`);

    if (failed > 0) {
      console.log('\n失败用例详情:');
      testResults.filter(r => !r.passed).forEach(r => {
        console.log(`  - ${r.name}`);
        if (r.error) console.log(`    原因: ${r.error}`);
      });
    }

    console.log('\n========================================\n');
    process.exit(failed > 0 ? 1 : 0);
  } catch (error) {
    console.error('测试执行出错:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
};

runTests();
