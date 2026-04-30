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
import correosRoutes from './correos.routes';
import notasRoutes from './notas.routes';
import uploadsRoutes from './uploads.routes';
import usuariosRoutes from './usuarios.routes';
import equiposRoutes from './equipos.routes';
import ticketsRoutes from './tickets.routes';
import fichasTecnicasRoutes from './fichas-tecnicas.routes';
import chatbotRoutes from './chatbot.routes';
import circuitosRoutes from './circuitos.routes';
import analisisOcupacionRoutes from './analisis-ocupacion.routes';
import historialRoutes from './historial.routes';

import publicRoutes from './public.routes';

const router = Router();

router.use('/auth', authRoutes);
router.use('/public', publicRoutes);
router.use('/clientes', clientesRoutes);
router.use('/proveedores', proveedoresRoutes);
router.use('/inventarios', inventariosRoutes);
router.use('/solicitudes', solicitudesRoutes);
router.use('/propuestas', propuestasRoutes);
router.use('/campanas', campanasRoutes);
router.use('/dashboard', dashboardRoutes);
router.use('/notificaciones', notificacionesRoutes);
router.use('/correos', correosRoutes);
router.use('/notas', notasRoutes);
router.use('/uploads', uploadsRoutes);
router.use('/usuarios', usuariosRoutes);
router.use('/equipos', equiposRoutes);
router.use('/tickets', ticketsRoutes);
router.use('/fichas-tecnicas', fichasTecnicasRoutes);
router.use('/chatbot', chatbotRoutes);
router.use('/circuitos', circuitosRoutes);
router.use('/analisis-ocupacion', analisisOcupacionRoutes);
router.use('/historial', historialRoutes);

export default router;
