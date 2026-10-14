// Normalización de caras 100% bonificación (BF/CF/CT).
//
// Regla "Balance Flujos v2": para artículos BF/CF/CT el conteo total vive en
// `solicitudCaras.bonificacion` (y `caras` = 0). El split flujo/contraflujo
// SÍ se persiste en `caras_flujo`/`caras_contraflujo` PERO solo se usa para
// el KPI visual del buscador de formatos — nada de SAP/auth/reportes lee
// esas columnas para BF/CF/CT.
//
// Comportamiento:
// - Si el front manda caras_flujo+caras_contraflujo > 0 y la suma <= total,
//   se respeta (el usuario movió el % de distribución).
// - Si no (front mandó 0/0 o nada), se aplica default 50/50 del total
//   (ceil/floor) — válido para tradicional fijo y digital recién creado.
//
// Bug histórico que esto corrige: al crear circuitos CT-DIG el form metía el
// conteo en `caras` y lo repartía como RT digital. CT Tradicional sobrevivía
// de chiripa (renta=0). El normalizador asegura caras=0, bonificacion=total
// y un split persistido en todos los paths de creación/edición.

// CF-#### (CF + dígitos, ej. CF-0017 / CF-0203 "Mantenimiento Extraordinario"):
// artículos de SERVICIO cobrado (caras>0, tarifa>0, costo>0) — NO son bonificación
// contraflujo aunque compartan el prefijo CF. Se manejan como IM (impresiones):
// sin inventario/reserva, pasan directo a campañas y se postean a SAP.
// Las bonificaciones reales del catálogo son BF-*/CT-* (código de plaza, no numérico).
export function esArticuloServicioCF(articulo?: string | null): boolean {
  return /^CF-?\d/i.test((articulo || '').trim());
}

// Artículo de bonificación BF/CF "real" (excluye los CF-#### de servicio).
export function esArticuloBfCf(articulo?: string | null): boolean {
  const a = (articulo || '').toUpperCase();
  return (a.startsWith('BF') || a.startsWith('CF')) && !esArticuloServicioCF(a);
}

export function isBonifSplitArticulo(articulo?: string | null): boolean {
  const a = (articulo || '').toUpperCase();
  if (esArticuloServicioCF(a)) return false;
  return a.startsWith('BF') || a.startsWith('CF') || a.startsWith('CT');
}

export interface BonifCaraOverride {
  caras: number;
  bonificacion: number;
  caras_flujo: number;
  caras_contraflujo: number;
}

// Devuelve los 4 campos normalizados si el artículo es BF/CF/CT; null si no
// aplica (el caller deja sus valores normales). El total se toma de
// caras + bonificacion porque para estos artículos exactamente uno de los
// dos trae el conteo (CT-Trad→bonificacion, CT-DIG→caras, BF/CF→caras).
export function bonifCaraOverride(
  articulo: string | null | undefined,
  caras: number | string | null | undefined,
  bonificacion: number | string | null | undefined,
  caras_flujo?: number | string | null,
  caras_contraflujo?: number | string | null,
): BonifCaraOverride | null {
  if (!isBonifSplitArticulo(articulo)) return null;
  const c = Number(caras) || 0;
  const b = Number(bonificacion) || 0;
  const total = c + b;

  const cf = Number(caras_flujo) || 0;
  const cc = Number(caras_contraflujo) || 0;
  // Respetar split del front si suma válida (>0 y <= total).
  if (cf + cc > 0 && cf + cc <= total) {
    return { caras: 0, bonificacion: total, caras_flujo: cf, caras_contraflujo: cc };
  }
  // Default 50/50 del total. Cuando total=0, ambos quedan en 0 también.
  return {
    caras: 0,
    bonificacion: total,
    caras_flujo: Math.ceil(total / 2),
    caras_contraflujo: Math.floor(total / 2),
  };
}

// ── Invariante de caras para circuitos de RENTA (RT, no BF/CF/CT) ───────────────
//
// Regla: en una fila RT `caras` SIEMPRE debe ser `caras_flujo + caras_contraflujo`.
// `caras` (el total) es la fuente de verdad; el split flujo/contra solo reparte ese
// total. Nunca debe persistirse una fila RT con caras != flujo+contra.
//
// Bug que corrige (2026-10-13, caso 81891/sc 20791): existían filas RT chuecas
// (caras=150 pero flujo+contra=25+25=50). El form de edición derivaba `caras` de
// flujo+contra y al guardar un cambio de NSE lo reenviaba como caras=50, recalculando
// costo = 50 × tarifa y disparando una re-autorización DCM indebida.
//
// Devuelve:
//   null                          → no aplica (BF/CF/CT, o el payload no toca
//                                    caras/flujo/contra → el caller deja su default).
//   { ok:false, error }           → cambio de split (% distribución) que NO suma el
//                                    total actual → el caller responde 400.
//   { ok:true, changed, caras, caras_flujo, caras_contraflujo } → valores
//                                    NORMALIZADOS a persistir (caras==flujo+contra).

export interface RtCarasInvarianteOk {
  ok: true;
  changed: boolean; // true si se re-derivó el split desde caras
  caras: number;
  caras_flujo: number;
  caras_contraflujo: number;
}
export interface RtCarasInvarianteErr {
  ok: false;
  error: string;
}
export type RtCarasInvarianteResult = RtCarasInvarianteOk | RtCarasInvarianteErr | null;

const toIntSafe = (v: unknown, def = 0): number => {
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : def;
};

export function rtCarasInvariante(
  articuloEfectivo: string | null | undefined,
  payload: { caras?: unknown; caras_flujo?: unknown; caras_contraflujo?: unknown } | null | undefined,
  actual: { caras?: unknown; caras_flujo?: unknown; caras_contraflujo?: unknown } | null | undefined,
): RtCarasInvarianteResult {
  // BF/CF/CT los normaliza bonifCaraOverride (invariante sobre `bonificacion`).
  if (isBonifSplitArticulo(articuloEfectivo)) return null;
  if (!payload) return null;

  const carasDef = payload.caras !== undefined && payload.caras !== null;
  const cfDef = payload.caras_flujo !== undefined && payload.caras_flujo !== null;
  const ccDef = payload.caras_contraflujo !== undefined && payload.caras_contraflujo !== null;

  // El payload no toca ninguno de los tres → no re-escribimos nada (una fila ya
  // chueca se limpia aparte con el script de datos, no en cada edición ajena).
  if (!carasDef && !cfDef && !ccDef) return null;

  const curCaras = toIntSafe(actual?.caras, 0);
  const curCf = toIntSafe(actual?.caras_flujo, 0);
  const curCc = toIntSafe(actual?.caras_contraflujo, 0);

  if (carasDef) {
    // `caras` es la fuente de verdad.
    const caras = Math.max(0, toIntSafe(payload.caras, curCaras));
    const cf = cfDef ? Math.max(0, toIntSafe(payload.caras_flujo, curCf)) : curCf;
    const cc = ccDef ? Math.max(0, toIntSafe(payload.caras_contraflujo, curCc)) : curCc;
    if (cf + cc === caras) {
      return { ok: true, changed: false, caras, caras_flujo: cf, caras_contraflujo: cc };
    }
    // Re-derivar flujo/contra DESDE caras: conserva el ratio si ambos > 0, si no 50/50.
    const denom = cf + cc;
    let nf: number;
    let nc: number;
    if (denom > 0 && cf > 0 && cc > 0) {
      nf = Math.round(caras * (cf / denom));
      nc = caras - nf;
    } else {
      nf = Math.ceil(caras / 2);
      nc = Math.floor(caras / 2);
    }
    return { ok: true, changed: true, caras, caras_flujo: nf, caras_contraflujo: nc };
  }

  // Solo viene el split (cambio de % distribución): debe sumar el `caras` ACTUAL.
  const cf = cfDef ? Math.max(0, toIntSafe(payload.caras_flujo, curCf)) : curCf;
  const cc = ccDef ? Math.max(0, toIntSafe(payload.caras_contraflujo, curCc)) : curCc;
  if (cf + cc !== curCaras) {
    return {
      ok: false,
      error: `El split flujo/contraflujo (${cf}+${cc}=${cf + cc}) debe sumar el total de caras del circuito (${curCaras}).`,
    };
  }
  return { ok: true, changed: false, caras: curCaras, caras_flujo: cf, caras_contraflujo: cc };
}
