import { Router } from 'express';
import { dashboardController } from '../controllers/dashboard.controller';
import { authMiddleware } from '../middleware/auth.middleware';

const router = Router();

// Aplicar autenticacion a todas las rutas
router.use(authMiddleware);

// Estadisticas principales con filtros
router.get('/stats', dashboardController.getStats.bind(dashboardController));

// Estadisticas filtradas por estatus (para interactividad)
router.get('/stats/:estatus_filtro', dashboardController.getStatsByEstatus.bind(dashboardController));

// Opciones para los filtros
router.get('/filter-options', dashboardController.getFilterOptions.bind(dashboardController));

// Widgets adicionales
router.get('/activity', dashboardController.getRecentActivity.bind(dashboardController));
router.get('/catorcenas', dashboardController.getUpcomingCatorcenas.bind(dashboardController));
router.get('/top-clientes', dashboardController.getTopClientes.bind(dashboardController));

// Estado de POST a SAP: campañas pendientes por postear vs posteadas (num + $)
router.get('/posteo-stats', dashboardController.getPosteoStats.bind(dashboardController));

// Inventario detallado con info de campañas/propuestas
router.get('/inventory-detail', dashboardController.getInventoryDetail.bind(dashboardController));

// Reporte "Pase a ventas" (CSV) — descarga directa
router.get('/pase-a-ventas-report', dashboardController.getPaseAVentasReport.bind(dashboardController));

export default router;
