/**
 * Normaliza plazas. `solicitudCaras.estados` trae el mismo lugar de mil formas:
 * mayúsculas/acentos inconsistentes ("GUADALAJARA" vs "Guadalajara", "LEÓN" vs
 * "León") y valores compuestos ("Ciudad de México / AM", "Ciudad de México,
 * Estado de México"). Separamos por "/" y ",", quitamos calificadores (AM), y
 * unificamos a un nombre canónico con acentos. Devuelve el SET de plazas de la
 * cara (una cara puede cubrir varias).
 */

// Restaura acentos/casing para plazas cuyo origen viene sin ellos (MAYÚS sin tilde).
const ALIAS: Record<string, string> = {
  'CIUDAD DE MEXICO': 'Ciudad de México',
  CDMX: 'Ciudad de México',
  DF: 'Ciudad de México',
  'ESTADO DE MEXICO': 'Estado de México',
  EDOMEX: 'Estado de México',
  GUADALAJARA: 'Guadalajara',
  MONTERREY: 'Monterrey',
  PUEBLA: 'Puebla',
  TIJUANA: 'Tijuana',
  LEON: 'León',
  TOLUCA: 'Toluca',
  VERACRUZ: 'Veracruz',
  MERIDA: 'Mérida',
  YUCATAN: 'Mérida',
  PACHUCA: 'Pachuca',
  ACAPULCO: 'Acapulco',
  'PUERTO VALLARTA': 'Puerto Vallarta',
  OAXACA: 'Oaxaca',
  CANCUN: 'Cancún',
  QUERETARO: 'Querétaro',
};

// Calificadores que no son plaza (área metropolitana, zonas).
const RUIDO = new Set(['AM', 'ZMG', 'ZMVM', 'AREA METROPOLITANA']);

const titleCase = (s: string): string =>
  s.toLowerCase().replace(/(^|[\s])\p{L}/gu, (m) => m.toUpperCase());

/** Plazas canónicas de un valor `estados` (puede ser compuesto). */
export function normalizaPlaza(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const out = new Set<string>();
  for (const seg of String(raw).split(/[/,]/)) {
    const limpio = seg.replace(/\s+/g, ' ').trim();
    if (!limpio) continue;
    const k = limpio.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
    if (RUIDO.has(k)) continue;
    out.add(ALIAS[k] ?? titleCase(limpio));
  }
  return [...out];
}
