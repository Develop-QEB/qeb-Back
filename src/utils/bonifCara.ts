// Normalización de caras 100% bonificación (BF/CF/CT).
//
// Regla del diseño "Balance Flujos": para artículos BF/CF/CT el conteo total
// SIEMPRE vive en `solicitudCaras.bonificacion`. `caras`, `caras_flujo` y
// `caras_contraflujo` quedan en 0 — el split flujo/contraflujo de las
// bonificadas es 100% front (hardcodeado/visual), nunca se persiste en BD.
//
// Bug que esto corrige: al crear circuitos CT-DIG el form mete el conteo en
// `caras` y lo reparte en caras_flujo/caras_contraflujo (como si fuera RT
// digital). CT Tradicional sobrevivía de chiripa (renta=0). Esto lo
// normaliza en el back para TODOS los paths de creación/edición, sin tener
// que mantener 3 modales de front sincronizados.

export function isBonifSplitArticulo(articulo?: string | null): boolean {
  const a = (articulo || '').toUpperCase();
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
): BonifCaraOverride | null {
  if (!isBonifSplitArticulo(articulo)) return null;
  const c = Number(caras) || 0;
  const b = Number(bonificacion) || 0;
  return {
    caras: 0,
    bonificacion: c + b,
    caras_flujo: 0,
    caras_contraflujo: 0,
  };
}
