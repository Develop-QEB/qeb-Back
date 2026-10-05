import prisma from './prisma';

// Filtro de destinatarios por preferencias de notificaciones.
// Semantica opt-out (ver schema.prisma usuario_preferencias_notif): la ausencia
// de fila significa "habilitado". Solo excluimos usuarios que tengan
// habilitado=false en la clave especifica O en el master global del canal
// (clase='__global__', clave='__all__').
//
// Uso tipico:
//   const activos = await filtrarPorPreferenciasNotif(
//     destinatarios,
//     { canal: 'popup', clase: 'notificacion', clave: 'desposteo' },
//   );

export interface DestinatarioBasico {
  id: number;
}

export interface FiltroPrefsInput {
  canal: 'popup' | 'email';
  clase: 'notificacion' | 'tarea';
  clave: string;
}

export async function filtrarPorPreferenciasNotif<T extends DestinatarioBasico>(
  destinatarios: T[],
  filtro: FiltroPrefsInput,
): Promise<T[]> {
  if (destinatarios.length === 0) return destinatarios;
  const ids = Array.from(new Set(destinatarios.map(d => d.id)));

  // Traemos las prefs relevantes de una sola consulta: master global del canal
  // + la clave especifica en su clase.
  const prefs = await prisma.usuario_preferencias_notif.findMany({
    where: {
      usuario_id: { in: ids },
      canal: filtro.canal,
      OR: [
        { clase: '__global__', clave: '__all__' },
        { clase: filtro.clase, clave: filtro.clave },
      ],
    },
    select: { usuario_id: true, clase: true, clave: true, habilitado: true },
  });

  // Un usuario queda excluido si tiene alguna fila habilitado=false. Cualquier
  // otra combinacion (habilitado=true o sin fila) se mantiene.
  const excluidos = new Set<number>();
  for (const p of prefs) {
    if (p.habilitado === false) excluidos.add(p.usuario_id);
  }
  return destinatarios.filter(d => !excluidos.has(d.id));
}
