import { Router } from 'express';
import authRoutes from './auth.routes';
import clientesRoutes from './clientes.routes';
import proveedoresRoutes from './proveedores.routes';
import inventariosRoutes from './inventarios.routes';
import solicitudesRoutes from './solicitudes.routes';
import propuestasRoutes from './propuestas.routes';
import campanasRoutes from './campanas.routes';
import dashboardRoutes from './dashboard.routes';
import notificacionesRoutes from './notificaciones.routes';

const router = Router();

router.use('/auth', authRoutes);
router.use('/clientes', clientesRoutes);
router.use('/proveedores', proveedoresRoutes);
router.use('/inventarios', inventariosRoutes);
router.use('/solicitudes', solicitudesRoutes);
router.use('/propuestas', propuestasRoutes);
router.use('/campanas', campanasRoutes);
router.use('/dashboard', dashboardRoutes);
router.use('/notificaciones', notificacionesRoutes);

export default router;
