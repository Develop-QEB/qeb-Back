/**
 * Gate de correos según preferencias del usuario (Fase 3).
 *
 * Devuelve true si se debe ENVIAR el correo. Semántica opt-out:
 * - Si no hay userId, no podemos filtrar → se envía.
 * - Ante cualquier error, no bloqueamos el correo → se envía.
 */
import { isPermitido } from '../services/preferenciasNotif.service';
import { ClaseNotif } from '../constants/notificaciones';

export async function correoPermitido(
  destinatarioId: number | null | undefined,
  clase: ClaseNotif,
  clave: string
): Promise<boolean> {
  if (destinatarioId == null) return true;
  try {
    return await isPermitido(destinatarioId, 'email', clase, clave);
  } catch {
    return true;
  }
}
