import { Router, Request, Response, NextFunction } from 'express';
import { propuestasController } from '../controllers/propuestas.controller';
import { verificarShareToken } from '../utils/shareToken';

const router = Router();

/**
 * Rutas sin sesión: la vista de propuesta que se comparte con el cliente.
 *
 * No son abiertas: exigen el token firmado que va en la liga (`?t=`). Antes
 * bastaba el id consecutivo de la propuesta, así que se podía recorrer desde 1
 * y leer cliente, CUIC, asesor, precio e inventario con coordenadas de todas
 * las propuestas. El token se emite desde la app con sesión abierta
 * (GET /api/propuestas/:id/share-link) y caduca.
 *
 * PUBLIC_SHARE_ALLOW_LEGACY=true acepta además ligas viejas sin token, para
 * una transición corta si alguien ya mandó ligas a clientes. Deja rastro en el
 * log para saber si todavía se usan. Por omisión está apagado.
 */
const permitirLegacy = (): boolean => process.env.PUBLIC_SHARE_ALLOW_LEGACY === 'true';

const guardShareToken = (req: Request, res: Response, next: NextFunction): void => {
  const propuestaId = parseInt(req.params.id, 10);
  if (!Number.isFinite(propuestaId) || propuestaId <= 0) {
    res.status(400).json({ success: false, error: 'Propuesta inválida' });
    return;
  }

  const resultado = verificarShareToken(propuestaId, req.query.t);
  if (resultado.ok) {
    next();
    return;
  }

  if (resultado.error === 'ausente' && permitirLegacy()) {
    console.warn(
      `[ShareLink] Acceso LEGACY sin token a la propuesta ${propuestaId} ` +
      `(ip=${req.ip}). Apaga PUBLIC_SHARE_ALLOW_LEGACY cuando ya no aparezca.`
    );
    next();
    return;
  }

  if (resultado.error === 'expirado') {
    res.status(410).json({
      success: false,
      code: 'SHARE_EXPIRADO',
      error: 'Esta liga ya venció. Solicita una nueva a tu asesor.',
    });
    return;
  }

  res.status(403).json({
    success: false,
    code: 'SHARE_INVALIDO',
    error: 'Liga no válida. Solicita una nueva a tu asesor.',
  });
};

router.get('/propuestas/:id', guardShareToken, propuestasController.getPublicDetails.bind(propuestasController));
// KML publico para abrir lo seleccionado en Google Maps (?ids=1,2,3)
router.get('/propuestas/:id/kml', guardShareToken, propuestasController.getPublicKML.bind(propuestasController));

// Se eliminó DELETE /campanas/:id/limpiar-artes-prueba (nov-2026): estaba
// marcada como TEMPORAL y borraba `archivo` y `arte_aprobado` de las reservas
// de cualquier campaña, sin sesión y sin registro de quién lo hizo. Si vuelve
// a hacer falta, va como endpoint autenticado y con historial.

export default router;
