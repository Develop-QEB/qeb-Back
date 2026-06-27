/**
 * Servicio de preferencias de notificaciones por usuario (Fase 1).
 *
 * Semántica OPT-OUT: si no hay fila, la notificación/correo está habilitado.
 * Solo se persisten las EXCEPCIONES (lo que el usuario apaga) y los toggles
 * maestros por canal.
 */
import prisma from '../utils/prisma';
import {
  CanalNotif,
  ClaseNotif,
  CANALES,
  CLASE_GLOBAL,
  CLAVE_MASTER,
  CATEGORIAS_NOTIFICACION,
  TIPOS_TAREA,
  normalizarClave,
} from '../constants/notificaciones';

export interface PreferenciaInput {
  canal: CanalNotif;
  clase: ClaseNotif | typeof CLASE_GLOBAL;
  clave: string;
  habilitado: boolean;
}

interface MatrizCanal {
  master: boolean;            // todo el canal (popup/email)
  masterNotificacion: boolean; // todas las notificaciones de este canal
  masterTarea: boolean;        // todas las tareas de este canal
  notificacion: Record<string, boolean>;
  tarea: Record<string, boolean>;
}

export interface MatrizPreferencias {
  popup: MatrizCanal;
  email: MatrizCanal;
}

/**
 * Devuelve la matriz completa de preferencias resueltas (todas las claves del
 * catálogo con su estado efectivo) para pintar la UI.
 */
export async function getPreferenciasUsuario(usuarioId: number): Promise<MatrizPreferencias> {
  const filas = await prisma.usuario_preferencias_notif.findMany({
    where: { usuario_id: usuarioId },
  });

  const buscar = (canal: CanalNotif, clase: string, claveNorm: string) =>
    filas.find(
      (f) => f.canal === canal && f.clase === clase && normalizarClave(f.clave) === claveNorm
    );

  const construirCanal = (canal: CanalNotif): MatrizCanal => {
    const masterRow = buscar(canal, CLASE_GLOBAL, normalizarClave(CLAVE_MASTER));
    const master = masterRow ? masterRow.habilitado : true;

    const masterNotifRow = buscar(canal, 'notificacion', normalizarClave(CLAVE_MASTER));
    const masterNotificacion = masterNotifRow ? masterNotifRow.habilitado : true;
    const masterTareaRow = buscar(canal, 'tarea', normalizarClave(CLAVE_MASTER));
    const masterTarea = masterTareaRow ? masterTareaRow.habilitado : true;

    const notificacion: Record<string, boolean> = {};
    for (const cat of CATEGORIAS_NOTIFICACION) {
      const row = buscar(canal, 'notificacion', normalizarClave(cat.clave));
      notificacion[cat.clave] = row ? row.habilitado : true;
    }

    const tarea: Record<string, boolean> = {};
    for (const t of TIPOS_TAREA) {
      const row = buscar(canal, 'tarea', normalizarClave(t.clave));
      tarea[t.clave] = row ? row.habilitado : true;
    }

    return { master, masterNotificacion, masterTarea, notificacion, tarea };
  };

  return {
    popup: construirCanal('popup'),
    email: construirCanal('email'),
  };
}

/** Guarda (upsert) un lote de preferencias. */
export async function setPreferencias(
  usuarioId: number,
  items: PreferenciaInput[]
): Promise<void> {
  await prisma.$transaction(
    items.map((it) =>
      prisma.usuario_preferencias_notif.upsert({
        where: {
          usuario_id_canal_clase_clave: {
            usuario_id: usuarioId,
            canal: it.canal,
            clase: it.clase,
            clave: it.clave,
          },
        },
        update: { habilitado: it.habilitado },
        create: {
          usuario_id: usuarioId,
          canal: it.canal,
          clase: it.clase,
          clave: it.clave,
          habilitado: it.habilitado,
        },
      })
    )
  );
}

/**
 * ¿Está permitido enviar por `canal` una notificación/tarea de (clase, clave)?
 * Honra el master del canal y la excepción específica. Default: true (opt-out).
 *
 * Lo usarán las fases siguientes (popups dirigidos y filtrado de correos).
 */
export async function isPermitido(
  usuarioId: number,
  canal: CanalNotif,
  clase: ClaseNotif,
  clave: string | null | undefined
): Promise<boolean> {
  const filas = await prisma.usuario_preferencias_notif.findMany({
    where: { usuario_id: usuarioId, canal },
  });

  // Master del canal (todo popup / todo email)
  const master = filas.find((f) => f.clase === CLASE_GLOBAL && f.clave === CLAVE_MASTER);
  if (master && !master.habilitado) return false;

  // Master de la clase (todas las notificaciones / todas las tareas del canal)
  const masterClase = filas.find((f) => f.clase === clase && f.clave === CLAVE_MASTER);
  if (masterClase && !masterClase.habilitado) return false;

  // Regla específica por categoría/tipo
  const claveNorm = normalizarClave(clave);
  const especifica = filas.find(
    (f) => f.clase === clase && f.clave !== CLAVE_MASTER && normalizarClave(f.clave) === claveNorm
  );
  return especifica ? especifica.habilitado : true;
}

/** Validación: canales y clases aceptadas. */
export function esCanalValido(c: string): c is CanalNotif {
  return (CANALES as string[]).includes(c);
}
export function esClaseValida(c: string): boolean {
  return c === 'notificacion' || c === 'tarea' || c === CLASE_GLOBAL;
}
