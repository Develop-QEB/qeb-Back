/**
 * Normaliza nombres de asesor. La BD guarda muchas variantes del mismo nombre:
 * sufijos de canal (" TRADE", " UDC", " VÍA PÚBLICA"), mayúsculas/acentos
 * inconsistentes, y apellidos de más ("FERNANDA MEJIA" vs "FERNANDA MEJIA
 * SANCHEZ", "ALDONZA OJEDA" vs "ALDONZA OJEDA POIRÉ"). No existe catálogo en
 * esta BD (BI_CRM_Asesor vive en otro entorno), así que limpiamos + diccionario
 * de alias para los casos de nombre variable, y Title Case para el resto.
 */

// Diccionario keyed por forma LIMPIA (sin acentos, MAYÚS, sin sufijo de canal).
const ALIAS: Record<string, string> = {
  'FERNANDA MEJIA': 'Fernanda Mejía',
  'FERNANDA MEJIA SANCHEZ': 'Fernanda Mejía',
  'MARIA FERNANDA MEJIA SANCHEZ': 'Fernanda Mejía',
  'ALDONZA OJEDA': 'Aldonza Ojeda',
  'ALDONZA OJEDA POIRE': 'Aldonza Ojeda',
  'ANA MARIA LOPEZ': 'Ana María López',
  'ANA LOPEZ': 'Ana María López',
  'ANA MARIA LOPEZ GONZALEZ': 'Ana María López',
  'SARA PICHARDO': 'Sara Pichardo',
  'BRISSA GONZALEZ': 'Brissa González',
  'KARLA BASURTO': 'Karla Basurto',
  'KARLA BASURTO MICHELENA': 'Karla Basurto',
  'LEONOR BARRANON': 'Leonor Barrañón',
  'LEONOR': 'Leonor Barrañón',
  'VALERIA TOSTADO': 'Valeria Tostado',
  'ALDO ADRIAN TAVERA': 'Aldo Tavera',
  'ALDO TAVERA': 'Aldo Tavera',
  'ALDO ADRIAN TAVERA GIL': 'Aldo Tavera',
  'ESTRELLA BEHAR': 'Estrella Behar',
  'ESTRELLA NANDO BEHAR': 'Estrella Behar',
  'LISSETT VALDEZ': 'Lissett Valdez',
  'LISSET VALDEZ': 'Lissett Valdez',
  'JOAQUIN CALDERON': 'Joaquín Calderón',
  'BEGONA BEORLEGUI': 'Begoña Beorlegui',
  'NOEMI MUNOZ': 'Noemí Muñoz',
  'EDNA GONZALEZ': 'Edna González',
  'EDNA GONZALEZ LABASTIDA': 'Edna González',
  'MONICA SOFIA SANCHEZ RUIZ': 'Mónica Sánchez',
  'MONICA SANCHEZ': 'Mónica Sánchez',
  'MONICA SOFIA SANCHEZ': 'Mónica Sánchez',
  'DULCE BALTIERRA': 'Dulce Baltierra',
  'ALEJANDRO I HERRERA': 'Alejandro Herrera',
  'ALEJANDRO ISAAC HERRERA REYES': 'Alejandro Herrera',
  'ALEJANDRO HERRERA': 'Alejandro Herrera',
  'VICTOR MENDIOLA': 'Víctor Mendiola',
  'JUAN LOPEZ CORTES': 'Juan López Cortés',
  'ELVIA IBARRA RAMIREZ': 'Elvia Ibarra',
  'ALEJANDRO M PEREZ': 'Alejandro Pérez',
  'ALEJANDRO PEREZ': 'Alejandro Pérez',
  'HILDA LETICIA LINAS': 'Hilda Linas',
  'ROCIO LOPEZ': 'Rocío López',
  'ROCIO LOPEZ ALCOCER': 'Rocío López',
  'JONATHAN ALVA': 'Jonathan Alva',
  'ELISA MACIN TEJEDA': 'Elisa Macín',
  'MARISSA SALGADO': 'Marissa Salgado',
  'ROSALVA OSORNIO MEJIA': 'Rosalva Osornio',
  'TANIA PEREZ': 'Tania Pérez',
  'CYNTHIA VARGAS': 'Cynthia Vargas',
  'CORPORATIVO': 'Corporativo',
};

/** Quita acentos, pasa a MAYÚS, colapsa espacios y quita el sufijo de canal. */
function claveLimpia(raw: string): string {
  let s = raw.normalize('NFD').replace(/[̀-ͯ]/g, '');
  s = s.toUpperCase().replace(/\s+/g, ' ').trim();
  s = s.replace(/\s+(TRADE|UDC|VIA PUBLICA)$/i, '').trim();
  return s;
}

const titleCase = (s: string): string =>
  s.toLowerCase().replace(/(^|\s)\p{L}/gu, (m) => m.toUpperCase());

/** Nombre canónico del asesor (o null si venía vacío). */
export function normalizaAsesor(raw: string | null | undefined): string | null {
  if (!raw || !String(raw).trim()) return null;
  const k = claveLimpia(String(raw));
  if (!k) return null;
  if (ALIAS[k]) return ALIAS[k];
  return titleCase(k);
}
