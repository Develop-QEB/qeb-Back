import prisma from './prisma';

// Helper centralizado para insertar registros consistentes en la tabla
// `historial`. Antes cada controller llamaba prisma.historial.create() con
// shape ligeramente distinto; este helper unifica el patron del JSON de
// `detalles` para que el screen de Historial de Acciones pueda mostrarlo
// de forma uniforme.
//
// Patron de `detalles` (JSON serializado en la columna TEXT):
// {
//   usuario: string,        // Nombre del usuario que realiza la accion
//   usuarioId?: number,     // ID del usuario que realiza la accion
//   usuarioRol?: string,    // Rol del usuario (Administrador / DEV / etc.)
//   origen: string,         // Modulo o screen: 'admin_usuarios', 'auth_self', 'tickets', etc.
//   accion: string,         // Accion humana: 'Creó', 'Editó', 'Eliminó', etc.
//   cambios?: Cambio[],     // Diff por campo en ediciones
//   extras?: any,           // Info adicional especifica del caso (datos eliminados, IDs afectados, etc.)
// }

export interface Cambio {
  campo: string;
  label: string;
  antes: unknown;
  despues: unknown;
}

export interface LogHistorialInput {
  tipo: string;            // 'usuario' | 'cliente' | 'proveedor' | 'ticket' | etc.
  refId: number;           // ID del recurso afectado (0 si no aplica)
  accion: string;          // Texto resumen para columna `accion`
  usuario: string;         // Nombre del autor
  usuarioId?: number;
  usuarioRol?: string;
  origen: string;          // Modulo/screen origen
  cambios?: Cambio[];
  extras?: Record<string, unknown>;
}

export async function logHistorial(input: LogHistorialInput): Promise<void> {
  try {
    const detalles: Record<string, unknown> = {
      usuario: input.usuario,
      origen: input.origen,
      accion: input.accion,
    };
    if (input.usuarioId !== undefined) detalles.usuarioId = input.usuarioId;
    if (input.usuarioRol !== undefined) detalles.usuarioRol = input.usuarioRol;
    if (input.cambios && input.cambios.length > 0) detalles.cambios = input.cambios;
    if (input.extras) Object.assign(detalles, input.extras);

    await prisma.historial.create({
      data: {
        tipo: input.tipo,
        ref_id: input.refId,
        accion: input.accion,
        detalles: JSON.stringify(detalles),
      },
    });
  } catch (err) {
    // Nunca tirar el endpoint por un fallo de auditoria. Logueamos y seguimos.
    console.error(`logHistorial fallo (tipo=${input.tipo}, ref=${input.refId}):`, err);
  }
}

// Autodetecta diferencias entre dos objetos y devuelve solo los campos que
// cambiaron. fieldLabels mapea campo tecnico -> label humano. Solo los
// campos presentes en fieldLabels son auditados (whitelist).
export function diffFields<T extends Record<string, unknown>>(
  antes: Partial<T>,
  despues: Partial<T>,
  fieldLabels: Record<string, string>,
): Cambio[] {
  const cambios: Cambio[] = [];
  for (const [campo, label] of Object.entries(fieldLabels)) {
    const a = antes[campo as keyof T];
    const d = despues[campo as keyof T];
    if (a === undefined && d === undefined) continue;
    const norm = (v: unknown) => (v === null || v === undefined ? '' : String(v));
    if (norm(a) !== norm(d)) {
      cambios.push({ campo, label, antes: a ?? null, despues: d ?? null });
    }
  }
  return cambios;
}
