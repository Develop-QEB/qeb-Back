import prisma from './prisma';

// Resuelve una fecha a su etiqueta de catorcena ("Cat N/AAAA") para los
// registros de historial. La tabla `catorcenas` es chica y casi inmutable, así
// que se cachea en memoria 10 min para no pegarle a la BD en cada acción.
//
// OJO: el campo Prisma del año es `a_o` (la columna real en la BD es `año`).

interface CatRange { numero: number; anio: number; ini: Date; fin: Date }

let cache: CatRange[] | null = null;
let cacheAt = 0;
const TTL_MS = 10 * 60 * 1000;

async function getCatorcenas(): Promise<CatRange[]> {
  const now = Date.now();
  if (cache && now - cacheAt < TTL_MS) return cache;
  const rows = await prisma.catorcenas.findMany({
    select: { numero_catorcena: true, a_o: true, fecha_inicio: true, fecha_fin: true },
  });
  cache = rows.map(r => ({
    numero: Number(r.numero_catorcena),
    anio: Number(r.a_o),
    ini: r.fecha_inicio instanceof Date ? r.fecha_inicio : new Date(r.fecha_inicio as unknown as string),
    fin: r.fecha_fin instanceof Date ? r.fecha_fin : new Date(r.fecha_fin as unknown as string),
  }));
  cacheAt = now;
  return cache;
}

// "Cat N/AAAA" para la fecha; si no cae en ninguna catorcena, la fecha ISO.
// '' si la fecha es nula/ inválida.
export async function catorcenaLabel(fecha: unknown): Promise<string> {
  if (!fecha) return '';
  const t = fecha instanceof Date ? fecha : new Date(fecha as string);
  if (isNaN(t.getTime())) return '';
  const cats = await getCatorcenas();
  const c = cats.find(x => t >= x.ini && t <= x.fin);
  if (c) return `Cat ${c.numero}/${c.anio}`;
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}
