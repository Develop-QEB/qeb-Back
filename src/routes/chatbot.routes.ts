import { Router } from 'express';
import { chatbotController } from '../controllers/chatbot.controller';
import { authMiddleware } from '../middleware/auth.middleware';

const router = Router();

router.use(authMiddleware);

router.post('/', chatbotController.chat.bind(chatbotController));
router.get('/logs', chatbotController.getLogs.bind(chatbotController));

export default router;
