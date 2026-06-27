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
}

/** Categorías de notificaciones (tipo='Notificación'). */
export const CATEGORIAS_NOTIFICACION: CatalogoItem[] = [
  { clave: 'cambio_estatus', label: 'Cambios de estado' },
  { clave: 'comentario', label: 'Comentarios en bitácora' },
  { clave: 'autorizacion', label: 'Autorizaciones (resultado)' },
  { clave: 'creacion_eliminacion', label: 'Creación / eliminación' },
  { clave: 'recordatorio', label: 'Recordatorios' },
  { clave: 'sistema', label: 'Sistema' },
  { clave: 'general', label: 'Otras notificaciones' },
];

/** Tipos de tarea (canónicos). El matching ignora acentos y mayúsculas. */
export const TIPOS_TAREA: CatalogoItem[] = [
  { clave: 'Autorización DG', label: 'Autorización DG' },
  { clave: 'Autorización DCM', label: 'Autorización DCM' },
  { clave: 'Revisión de artes', label: 'Revisión de artes' },
  { clave: 'Corrección', label: 'Corrección' },
  { clave: 'Ajuste Cto Cliente', label: 'Ajuste CTO Cliente' },
  { clave: 'Ajuste Comercial', label: 'Ajuste Comercial' },
  { clave: 'Ajuste de Caras', label: 'Ajuste de Caras' },
  { clave: 'Instalación', label: 'Instalación' },
  { clave: 'Impresión', label: 'Impresión' },
  { clave: 'Testigo', label: 'Testigo' },
  { clave: 'Programación', label: 'Programación' },
  { clave: 'Recepción', label: 'Recepción' },
  { clave: 'Producción', label: 'Producción' },
  { clave: 'Seguimiento', label: 'Seguimiento' },
];

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
 * Catálogo de preferencias RELEVANTE para un usuario según su rol/puesto.
 * Las notificaciones son universales; los tipos de tarea se filtran a lo que ese
 * rol realmente puede recibir (refleja las reglas de asignación del sistema).
 */
export function catalogoParaUsuario(
  userRole?: string | null,
  puesto?: string | null
): { notificacion: CatalogoItem[]; tarea: CatalogoItem[] } {
  const rol = normalizarClave(userRole);
  const pst = normalizarClave(puesto);

  // Admin/DEV ven todo (gestión/pruebas).
  if (rol === 'administrador' || rol === 'dev') {
    return { notificacion: CATEGORIAS_NOTIFICACION, tarea: TIPOS_TAREA };
  }

  const esDiseno = rol === 'disenadores' || rol === 'coordinador de diseno';
  const valoresDG = ['dg', 'director general', 'direccion general'];
  const valoresDCM = ['dcm', 'director comercial', 'direccion comercial'];
  const esDG = valoresDG.includes(rol) || valoresDG.includes(pst);
  const esDCM = valoresDCM.includes(rol) || valoresDCM.includes(pst);

  // Diseño: SOLO tareas de artes (igual que el filtro de getAll).
  if (esDiseno) {
    const arte = TIPOS_TAREA.filter((t) => t.clave === 'Revisión de artes' || t.clave === 'Corrección');
    return { notificacion: CATEGORIAS_NOTIFICACION, tarea: arte };
  }

  // Resto: todo menos los tipos exclusivos de otro rol.
  const tarea = TIPOS_TAREA.filter((t) => {
    if (t.clave === 'Autorización DG') return esDG;
    if (t.clave === 'Autorización DCM') return esDCM;
    if (t.clave === 'Revisión de artes' || t.clave === 'Corrección') return false; // solo Diseño
    return true;
  });

  return { notificacion: CATEGORIAS_NOTIFICACION, tarea };
}
