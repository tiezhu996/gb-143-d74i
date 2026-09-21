import { Router, Response } from 'express';
import { validateRequest, validateQuery, createCorrectionSchema, paginationSchema } from '../middleware/validator';
import {
  createCorrection,
  getCorrectionById,
  getCorrections,
} from '../services/correctionService';
import { AuthRequest, requireVolunteerOrAdmin } from '../middleware/auth';
import { sendInternalError } from '../utils/httpResponses';

const router = Router();

router.use(requireVolunteerOrAdmin);

// 志愿者提交本人记录的纠错申请（管理员不可代为提交）
router.post('/', validateRequest(createCorrectionSchema), async (req: AuthRequest, res: Response) => {
  try {
    if (req.user?.role !== 'volunteer') {
      res.status(403).json({ success: false, error: '仅志愿者可提交纠错申请' });
      return;
    }
    const result = await createCorrection(
      req.user.id,
      req.body.service_record_id,
      {
        corrected_duration_hours: req.body.corrected_duration_hours,
        corrected_service_type: req.body.corrected_service_type,
        corrected_rating: req.body.corrected_rating,
        reason: req.body.reason,
      }
    );
    const statusCode = result.success ? 201 : 400;
    res.status(statusCode).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error creating record correction');
  }
});

// 我的纠错申请列表（管理员可借 volunteer_id / service_record_id / status 筛选）
router.get('/', validateQuery(paginationSchema), async (req: AuthRequest, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const pageSize = parseInt(req.query.page_size as string) || 20;
    const isAdmin = req.user?.role === 'admin';

    const filters = {
      status: req.query.status as string | undefined,
      volunteerId: isAdmin ? (req.query.volunteer_id as string | undefined) : req.user?.id,
      serviceRecordId: req.query.service_record_id as string | undefined,
    };

    const result = await getCorrections(page, pageSize, filters);
    res.status(200).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error getting record corrections');
  }
});

router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const result = await getCorrectionById(req.params.id);
    if (!result.success) {
      res.status(404).json(result);
      return;
    }
    // 志愿者只能查看本人的申请
    if (req.user?.role !== 'admin' && result.data?.volunteer_id !== req.user?.id) {
      res.status(403).json({ success: false, error: '只能查看本人的纠错申请' });
      return;
    }
    res.status(200).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error getting record correction');
  }
});

export default router;
