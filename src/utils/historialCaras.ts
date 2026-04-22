import prisma from './prisma';

interface CaraSnapshot {
  id: number;
  caras: number;
  bonificacion: number | null;
  costo: number | null;
  tarifa_publica: number | null;
  autorizacion_dg: string | null;
  autorizacion_dcm: string | null;
  articulo: string | null;
  ciudad: string | null;
}

const TRACKED_FIELDS: Record<string, string> = {
  caras: 'Caras',
  bonificacion: 'Bonificación',
  costo: 'Inversión',
  tarifa_publica: 'Tarifa pública',
  autorizacion_dg: 'Autorización DG',
  autorizacion_dcm: 'Autorización DCM',
};

function formatValue(field: string, value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (field === 'costo' || field === 'tarifa_publica') {
    return `$${Number(value).toLocaleString('es-MX', { minimumFractionDigits: 0 })}`;
  }
  return String(value);
}

export async function snapshotCaras(caraIds: number[]): Promise<Map<number, CaraSnapshot>> {
  if (caraIds.length === 0) return new Map();
  const caras = await prisma.solicitudCaras.findMany({
    where: { id: { in: caraIds } },
    select: {
      id: true,
      caras: true,
      bonificacion: true,
      costo: true,
      tarifa_publica: true,
      autorizacion_dg: true,
      autorizacion_dcm: true,
      articulo: true,
      ciudad: true,
    },
  });
  const map = new Map<number, CaraSnapshot>();
  for (const c of caras) {
    map.set(c.id, {
      id: c.id,
      caras: c.caras,
      bonificacion: c.bonificacion ? Number(c.bonificacion) : null,
      costo: c.costo ? Number(c.costo) : null,
      tarifa_publica: c.tarifa_publica ? Number(c.tarifa_publica) : null,
      autorizacion_dg: c.autorizacion_dg,
      autorizacion_dcm: c.autorizacion_dcm,
      articulo: c.articulo,
      ciudad: c.ciudad,
    });
  }
  return map;
}

export async function registrarCambiosCaras(
  refId: number,
  origen: 'solicitud' | 'propuesta' | 'campana',
  usuarioNombre: string,
  before: Map<number, CaraSnapshot>,
  afterIds: number[],
): Promise<void> {
  if (afterIds.length === 0) return;

  const afterMap = await snapshotCaras(afterIds);
  const cambios: { caraId: number; articulo: string; campo: string; label: string; antes: string; despues: string }[] = [];

  for (const [id, after] of afterMap) {
    const prev = before.get(id);
    if (!prev) continue;

    for (const [field, label] of Object.entries(TRACKED_FIELDS)) {
      const oldVal = (prev as unknown as Record<string, unknown>)[field];
      const newVal = (after as unknown as Record<string, unknown>)[field];
      const oldNum = oldVal !== null && oldVal !== undefined ? Number(oldVal) : null;
      const newNum = newVal !== null && newVal !== undefined ? Number(newVal) : null;
      const isNumeric = field !== 'autorizacion_dg' && field !== 'autorizacion_dcm';

      const changed = isNumeric
        ? oldNum !== newNum
        : String(oldVal ?? '') !== String(newVal ?? '');

      if (changed) {
        cambios.push({
          caraId: id,
          articulo: after.articulo || `Cara #${id}`,
          campo: field,
          label,
          antes: formatValue(field, oldVal),
          despues: formatValue(field, newVal),
        });
      }
    }
  }

  if (cambios.length === 0) return;

  const resumen = cambios.length === 1
    ? `${usuarioNombre} cambió ${cambios[0].label} de ${cambios[0].antes} → ${cambios[0].despues}`
    : `${usuarioNombre} modificó ${cambios.length} campo(s)`;

  await prisma.historial.create({
    data: {
      tipo: `autorizacion_cambio_${origen}`,
      ref_id: refId,
      accion: resumen,
      detalles: JSON.stringify({ usuario: usuarioNombre, origen, cambios }),
    },
  });
}

export async function registrarCaraNueva(
  refId: number,
  origen: 'solicitud' | 'propuesta' | 'campana',
  usuarioNombre: string,
  caraId: number,
): Promise<void> {
  const snap = await snapshotCaras([caraId]);
  const cara = snap.get(caraId);
  if (!cara) return;

  await prisma.historial.create({
    data: {
      tipo: `autorizacion_nueva_cara_${origen}`,
      ref_id: refId,
      accion: `${usuarioNombre} agregó circuito ${cara.articulo || `#${caraId}`} (${cara.caras} caras, ${formatValue('costo', cara.costo)})`,
      detalles: JSON.stringify({
        usuario: usuarioNombre,
        origen,
        cara: { id: caraId, articulo: cara.articulo, caras: cara.caras, costo: cara.costo, tarifa_publica: cara.tarifa_publica },
      }),
    },
  });
}
