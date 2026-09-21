import { Router, Response } from 'express';
import {
  validateRequest,
  validateQuery,
  createCorrectionSchema,
  handleCorrectionSchema,
  correctionListQuerySchema,
} from '../middleware/validator';
import { AuthRequest, requireAdmin } from '../middleware/auth';
import {
  createCorrectionRequest,
  handleCorrectionRequest,
  getCorrectionRequests,
  getCorrectionRequestById,
} from '../services/correctionService';
import { sendInternalError } from '../utils/httpResponses';

const router = Router();

// 志愿者查看本人的纠错申请；管理员可通过 query 参数查看全部或按条件筛选
router.get('/', validateQuery(correctionListQuerySchema), async (req: AuthRequest, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const pageSize = parseInt(req.query.page_size as string) || 20;
    const isAdmin = req.user?.role === 'admin';

    const result = await getCorrectionRequests(page, pageSize, {
      status: req.query.status as string | undefined,
      volunteerId: isAdmin ? req.query.volunteer_id as string | undefined : req.user?.id,
      recordId: req.query.record_id as string | undefined,
    });
    res.status(200).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error listing correction requests');
  }
});

router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const result = await getCorrectionRequestById(req.params.id);

    if (!result.success) {
      res.status(404).json(result);
      return;
    }

    // 志愿者只能查看本人的纠错申请
    if (req.user?.role !== 'admin' && result.data.volunteer_id !== req.user?.id) {
      res.status(403).json({ success: false, error: '只能查看本人的纠错申请' });
      return;
    }

    res.status(200).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error getting correction request');
  }
});

// 志愿者对指定服务记录提交纠错申请（每人每条记录只能提交一次）
router.post('/records/:recordId', validateRequest(createCorrectionSchema), async (req: AuthRequest, res: Response) => {
  try {
    if (req.user?.role === 'admin') {
      res.status(403).json({ success: false, error: '只有志愿者可以提交纠错申请' });
      return;
    }

    const result = await createCorrectionRequest(req.params.recordId, req.user!.id, {
      corrected_duration_hours: req.body.corrected_duration_hours,
      corrected_service_type: req.body.corrected_service_type,
      corrected_rating: req.body.corrected_rating,
      reason: req.body.reason,
    });
    const statusCode = result.success ? 201 : 400;
    res.status(statusCode).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error creating correction request');
  }
});

// 管理员批准 / 驳回纠错申请
router.post('/:id/handle', requireAdmin, validateRequest(handleCorrectionSchema), async (req: AuthRequest, res: Response) => {
  try {
    const adminId = req.user?.id || 'admin';
    const result = await handleCorrectionRequest(
      req.params.id,
      req.body.action,
      adminId,
      req.body.resolution
    );
    const statusCode = result.success ? 200 : 400;
    res.status(statusCode).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error handling correction request');
  }
});

export default router;
