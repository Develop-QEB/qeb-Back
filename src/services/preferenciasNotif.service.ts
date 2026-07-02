/**
 * Servicio de preferencias de notificaciones por usuario.
 *
 * Default POR CANAL:
 *  - email → ON por defecto (opt-out): llega salvo que el usuario lo apague.
 *  - popup → OFF por defecto (opt-in): NO sale salvo que el usuario lo encienda.
 *
 * Resolución por herencia: fila específica → master de clase → master de canal
 * → default del canal.
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
    const canalDefault = canal === 'email'; // email ON por defecto, popup OFF

    const valorMaster = (): boolean => {
      const r = buscar(canal, CLASE_GLOBAL, normalizarClave(CLAVE_MASTER));
      return r ? r.habilitado : canalDefault;
    };
    const valorClaseMaster = (clase: 'notificacion' | 'tarea'): boolean => {
      const r = buscar(canal, clase, normalizarClave(CLAVE_MASTER));
      return r ? r.habilitado : valorMaster();
    };
    const valorEspecifico = (clase: 'notificacion' | 'tarea', clave: string): boolean => {
      const r = buscar(canal, clase, normalizarClave(clave));
      return r ? r.habilitado : valorClaseMaster(clase);
    };

    const master = valorMaster();
    const masterNotificacion = valorClaseMaster('notificacion');
    const masterTarea = valorClaseMaster('tarea');

    const notificacion: Record<string, boolean> = {};
    for (const cat of CATEGORIAS_NOTIFICACION) {
      notificacion[cat.clave] = valorEspecifico('notificacion', cat.clave);
    }

    const tarea: Record<string, boolean> = {};
    for (const t of TIPOS_TAREA) {
      tarea[t.clave] = valorEspecifico('tarea', t.clave);
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
 * Resolución por herencia: específica → master de clase → master de canal →
 * default del canal (email ON, popup OFF).
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
  const canalDefault = canal === 'email'; // email ON por defecto, popup OFF

  // Regla específica por categoría/tipo
  const claveNorm = normalizarClave(clave);
  const especifica = filas.find(
    (f) => f.clase === clase && f.clave !== CLAVE_MASTER && normalizarClave(f.clave) === claveNorm
  );
  if (especifica) return especifica.habilitado;

  // Master de la clase (todas las notificaciones / todas las tareas del canal)
  const masterClase = filas.find((f) => f.clase === clase && f.clave === CLAVE_MASTER);
  if (masterClase) return masterClase.habilitado;

  // Master del canal (todo popup / todo email)
  const master = filas.find((f) => f.clase === CLASE_GLOBAL && f.clave === CLAVE_MASTER);
  if (master) return master.habilitado;

  return canalDefault;
}

/** Validación: canales y clases aceptadas. */
export function esCanalValido(c: string): c is CanalNotif {
  return (CANALES as string[]).includes(c);
}
export function esClaseValida(c: string): boolean {
  return c === 'notificacion' || c === 'tarea' || c === CLASE_GLOBAL;
}
