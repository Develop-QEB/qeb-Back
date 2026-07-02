/**
 * Taxonomía central de notificaciones y tareas + preferencias por usuario.
 *
 * - Las NOTIFICACIONES (tareas con tipo='Notificación') se subclasifican con el
 *   campo `categoria`. Aquí está el catálogo de categorías.
 * - Las TAREAS reales ya se distinguen por su `tipo`; ese tipo hace de categoría.
 *
 * Este catálogo lo consumen tanto el backend (resolver preferencias, etiquetar
 * notificaciones) como, vía endpoint, el frontend (pintar la UI de config).
 */

export type ClaseNotif = 'notificacion' | 'tarea';
export type CanalNotif = 'popup' | 'email';

export const CANALES: CanalNotif[] = ['popup', 'email'];

// Claves especiales para el "master" (activar/desactivar todo un canal).
export const CLASE_GLOBAL = '__global__';
export const CLAVE_MASTER = '__all__';

export interface CatalogoItem {
  clave: string;
  label: string;
  /** false = este tipo NO envía correo → el frontend oculta su toggle de correo. */
  email?: boolean;
}

/** Categorías de notificaciones (tipo='Notificación'). Solo las que se usan. */
export const CATEGORIAS_NOTIFICACION: CatalogoItem[] = [
  { clave: 'cambio_estatus', label: 'Cambios de estado' },
  { clave: 'comentario', label: 'Comentarios en bitácora' },
  { clave: 'recordatorio', label: 'Recordatorios' },
  // 'general' es el comodín (ediciones y demás avisos varios).
  { clave: 'general', label: 'Ediciones' },
];

/**
 * Tipos de tarea CANÓNICOS (los que se ofrecen como toggle). Cada uno agrupa
 * las variantes reales vía `canonicalizarTipoTarea`. El matching ignora acentos
 * y mayúsculas. Solo se incluyen tipos que REALMENTE se crean en el sistema.
 */
export const TIPOS_TAREA: CatalogoItem[] = [
  { clave: 'Autorización DG', label: 'Autorización DG' },
  { clave: 'Autorización DCM', label: 'Autorización DCM' },
  { clave: 'Resultado de autorización', label: 'Resultado de autorización (aprobada/rechazada)', email: false },
  { clave: 'Revisión de artes', label: 'Revisión de artes' },
  { clave: 'Corrección', label: 'Corrección' },
  { clave: 'Ajuste Cto Cliente', label: 'Ajuste CTO Cliente' },
  { clave: 'Ajuste Comercial', label: 'Ajuste Comercial' },
  { clave: 'Impresión', label: 'Impresión' },
  { clave: 'Instalación', label: 'Instalación', email: false },
  { clave: 'Programación', label: 'Programación', email: false },
  { clave: 'Recepción', label: 'Recepción', email: false },
  { clave: 'Producción', label: 'Producción', email: false },
  { clave: 'Seguimiento', label: 'Seguimiento' },
];

/**
 * Mapea el `tipo` real de una fila de tareas a su clave canónica del catálogo,
 * para que las preferencias por tipo cubran todas las variantes de nombre.
 * Ej: 'Seguimiento Solicitud' → 'Seguimiento'; 'Aprobación DG' → 'Resultado de
 * autorización'; 'Orden de Programación' → 'Programación'.
 */
export function canonicalizarTipoTarea(tipo: string | null | undefined): string {
  const t = normalizarClave(tipo);
  if (!t) return '';
  if (t.startsWith('seguimiento')) return 'Seguimiento';
  if (t.startsWith('aprobacion') || t.startsWith('rechazo')) return 'Resultado de autorización';
  if (t.startsWith('autorizacion dg')) return 'Autorización DG';
  if (t.startsWith('autorizacion dcm')) return 'Autorización DCM';
  if (t.includes('orden de programacion') || t === 'programacion') return 'Programación';
  if (t.includes('orden de instalacion') || t === 'instalacion') return 'Instalación';
  if (t.includes('recepcion')) return 'Recepción'; // incluye "Gestión de Recepción Parcial"
  if (t.startsWith('ajuste cto')) return 'Ajuste Cto Cliente';
  if (t.startsWith('ajuste comercial')) return 'Ajuste Comercial';
  if (t.startsWith('revision de artes')) return 'Revisión de artes';
  if (t.startsWith('correccion')) return 'Corrección';
  // Coincidencia exacta contra el catálogo (normalizada); si no, deja el tipo tal cual.
  const match = TIPOS_TAREA.find((x) => normalizarClave(x.clave) === t);
  return match ? match.clave : (tipo || '');
}

export const CATEGORIA_DEFAULT = 'general';

/** Normaliza una clave para comparar sin acentos ni mayúsculas. */
export function normalizarClave(valor: string | null | undefined): string {
  return (valor || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase();
}

/** Lista de claves válidas por clase (normalizadas para validación). */
export function clavesValidas(clase: ClaseNotif): Set<string> {
  const lista = clase === 'notificacion' ? CATEGORIAS_NOTIFICACION : TIPOS_TAREA;
  return new Set(lista.map((i) => normalizarClave(i.clave)));
}

/**
 * Catálogo COMPLETO de preferencias. El filtrado por rol se hace en el frontend
 * con `getPermissions` (fuente de verdad de permisos), por eso aquí devolvemos
 * todo el catálogo reconciliado.
 */
export function catalogoCompleto(): { notificacion: CatalogoItem[]; tarea: CatalogoItem[] } {
  return { notificacion: CATEGORIAS_NOTIFICACION, tarea: TIPOS_TAREA };
}
