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
