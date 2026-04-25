// Circuitos Digitales IMU — helper compartido backend + frontend
//
// Un "circuito" es un grupo predefinido de ~50 inventarios (20 en MR)
// identificados por la combinación CTO + plaza en la tabla inventarios.
// Se venden como un artículo único tipo `RT-DIG-{nn}-{plazaCode}`.
//
// Ejemplos:
//   RT-DIG-03-MX → Renta circuito 3, Ciudad de México / AM
//   BF-DIG-01-MTY → Bonificación circuito 1, Monterrey
//   CT-DIG-05-MR → Cortesía circuito 5, Mérida
//
// Reglas:
// - Bonificación usa el MISMO artículo RT-DIG-NN (no hay BF paralelo)
//   por lo que el prefijo BF es informativo, pero la cara se guarda como RT
// - Total fijo = count de inventarios del circuito
// - Auto-reserva todo-o-nada al crear propuesta
// - Autorización: aprobado automático (pending tabulador real)

export const CIRCUITO_REGEX = /^(RT|BF|CT|CF)-DIG-(\d+)-([A-Z]+)$/i;

export const PLAZA_CODE_TO_LABEL: Record<string, string> = {
  MX: 'Ciudad de México / AM',
  MTY: 'Monterrey',
  // MR: pending — otros archivos
};

export interface CircuitoInfo {
  tipo: 'RT' | 'BF' | 'CT' | 'CF';
  cto: number;         // 1..5 (o futuros)
  ctoLabel: string;    // "CTO 3"
  plazaCode: string;   // "MX"
  plazaLabel: string;  // "Ciudad de México / AM" (fallback: plazaCode si no está mapeada)
  itemCode: string;    // raw input
}

/**
 * Detecta si un ItemCode corresponde a un circuito digital.
 * Devuelve null si no matchea el patrón.
 */
export function parseCircuitoDigital(itemCode: string | null | undefined): CircuitoInfo | null {
  if (!itemCode) return null;
  const m = itemCode.trim().match(CIRCUITO_REGEX);
  if (!m) return null;
  const tipo = m[1].toUpperCase() as CircuitoInfo['tipo'];
  const cto = parseInt(m[2], 10);
  if (!Number.isFinite(cto) || cto <= 0) return null;
  const plazaCode = m[3].toUpperCase();
  return {
    tipo,
    cto,
    ctoLabel: `CTO ${cto}`,
    plazaCode,
    plazaLabel: PLAZA_CODE_TO_LABEL[plazaCode] || plazaCode,
    itemCode: itemCode.trim(),
  };
}

/**
 * True si el ItemCode es circuito digital.
 */
export function isCircuitoDigital(itemCode: string | null | undefined): boolean {
  return parseCircuitoDigital(itemCode) !== null;
}

/**
 * Clave única del circuito (para deduplicación en propuestas).
 * Dos artículos-circuito se consideran el mismo si tienen mismo CTO y mismo plazaCode
 * (el tipo RT/BF/CT/CF no afecta — son aspectos del mismo grupo).
 */
export function circuitoKey(info: CircuitoInfo): string {
  return `CTO${info.cto}-${info.plazaCode}`;
}
