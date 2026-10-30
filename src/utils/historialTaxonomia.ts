// Taxonomia del Historial de Acciones: clasifica cada entrada en dos ejes
// ortogonales que el screen cruza con AND.
//
//   MODULO    -> sobre QUE se actuo (circuito, reserva, arte, usuario, ...)
//   CATEGORIA -> QUE se hizo        (creacion, eliminacion, autorizacion, ...)
//
// Por que dos ejes: la tabla `historial` guarda `tipo` (el expediente donde
// quedo anotado: Campaña #123) y `accion` (texto libre ya redactado). El
// objeto real de la accion NO esta en `tipo`: una fila con tipo='Campaña' y
// accion='Eliminación de reservas' trata de una RESERVA, la campaña es solo
// el expediente. Por eso el modulo se resuelve primero por lo que dice la
// accion y solo cae al `tipo` como ultimo recurso.
//
// -------------------------------------------------------------------------
// POR QUE LAS REGLAS SON DATOS Y NO CODIGO
// -------------------------------------------------------------------------
// La clasificacion se usa en dos lugares distintos:
//   1. El WHERE de la consulta (SQL, via Prisma) cuando el usuario filtra.
//   2. La etiqueta de cada fila devuelta (JS, sobre el resultado).
// Si fueran dos implementaciones separadas acabarian divergiendo y el usuario
// filtraria "Eliminación" para recibir filas etiquetadas "Otro". Declarando
// cada regla como un Patron[] y derivando AMBOS de ahi, eso no puede pasar.
//
// Cuidado con la comparacion: MySQL compara segun la collation de la columna
// (sin distinguir mayusculas, y normalmente tampoco acentos) mientras que JS
// distingue ambas. El evaluador JS normaliza (minusculas + sin diacriticos) y
// los patrones evitan acentos donde se puede ('liminaci' en vez de
// 'Eliminación'), tecnica que ya usa categoriaSql() en src/bi. Donde el
// acento es inevitable se incluyen las dos variantes, y como los patrones de
// una regla se combinan en OR, cualquiera de las dos collations acierta.

export type CampoPatron = 'tipo' | 'accion';
export type OpPatron = 'equals' | 'startsWith' | 'contains';

export interface Patron {
  campo: CampoPatron;
  op: OpPatron;
  valor: string;
}

export interface Regla {
  value: string;
  label: string;
  /** Encabezado de seccion en el dropdown del front. */
  grupo: string;
  /** Se cumple si matchea AL MENOS UNO (OR). */
  patrones: Patron[];
}

const p = (campo: CampoPatron, op: OpPatron, valor: string): Patron => ({ campo, op, valor });

/** Quita diacriticos: 'Campaña' -> 'Campana', 'Edición' -> 'Edicion'. */
const sinAcentos = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

/**
 * Por cada valor con acentos agrega su gemelo sin acentos. Es lo que vuelve
 * la taxonomia independiente de la collation de MySQL: utf8mb4_general_ci
 * trata 'ñ' y 'n' como iguales pero utf8mb4_spanish_ci no, asi que un patron
 * 'campaña' podria no encontrar 'campana' (o al reves) segun la base. Con las
 * dos variantes en OR, cualquiera de las dos collations acierta. En el
 * evaluador JS ambas normalizan igual, asi que no cambia nada ahi.
 */
const conVariantes = (campo: CampoPatron, op: OpPatron, vs: string[]): Patron[] => {
  const todos = new Set<string>();
  for (const v of vs) { todos.add(v); todos.add(sinAcentos(v)); }
  return [...todos].map(v => p(campo, op, v));
};

const accionContiene = (...vs: string[]) => conVariantes('accion', 'contains', vs);
const accionEs = (...vs: string[]) => conVariantes('accion', 'equals', vs);
const tipoEs = (...vs: string[]) => conVariantes('tipo', 'equals', vs);
const tipoEmpieza = (...vs: string[]) => conVariantes('tipo', 'startsWith', vs);
const tipoContiene = (...vs: string[]) => conVariantes('tipo', 'contains', vs);

// -------------------------------------------------------------------------
// ETAPAS — en que punto del flujo comercial ocurrio.
// -------------------------------------------------------------------------
// Solo existen tres: Solicitud -> Propuesta -> Campaña. Es el tercer eje y
// el mas simple: responde "donde" en el proceso de negocio, mientras que
// MODULO responde "sobre que" y CATEGORIA "que se hizo".
//
// La etapa se asigna por DONDE SE OPERA el evento, no por lo que apunta
// `ref_id`. Artes, APS, posteo, instalacion y desposteo se trabajan desde
// Campañas y por eso son etapa Campaña, aunque varios de ellos guarden el id
// de la propuesta en `ref_id` (el dato crudo es inconsistente: incluso
// tipo='Campaña' guarda unas veces campania_id y otras id_propuesta).
//
// Lo que no pertenece al flujo comercial — usuarios, clientes, proveedores,
// tickets, inventario, capas de mapa — se queda SIN etapa a proposito. Y los
// tipos genericos 'autorizacion_aprobacion' / 'autorizacion_rechazo' tampoco
// dicen de que expediente son, asi que tampoco se les inventa una.
export const ETAPAS: Regla[] = [
  {
    value: 'campana', label: 'Campaña', grupo: 'Flujo',
    patrones: [
      ...tipoEs('Campaña', 'campana', 'Desposteo', 'Instalación'),
      ...tipoEmpieza('Arte'),
      ...tipoContiene('campaña'),              // autorizacion_*_campana
      ...accionContiene('post aps', 'de aps', 'aps pre', ' aps ', 'a sap', 'desposteo'),
    ],
  },
  {
    value: 'propuesta', label: 'Propuesta', grupo: 'Flujo',
    patrones: [...tipoEs('Propuesta'), ...tipoContiene('propuesta')],
  },
  {
    value: 'solicitud', label: 'Solicitud', grupo: 'Flujo',
    patrones: [...tipoEs('Solicitud'), ...tipoContiene('solicitud')],
  },
];

/** Etapas + los tipos que comparten el espacio de ids de propuesta/campaña. */
export const SIN_ETAPA = 'sin_etapa';

export const ETAPA_NINGUNA: Regla = {
  value: SIN_ETAPA, label: 'Fuera del flujo', grupo: 'Otros', patrones: [],
};

// -------------------------------------------------------------------------
// MODULOS — en ORDEN DE PRIORIDAD: gana la primera regla que matchea.
// -------------------------------------------------------------------------
// El orden es la parte delicada. Casos que lo justifican:
//   - `desposteo` antes que `aps`: "Solicito desposteo APS 123" menciona APS
//     pero el modulo que interesa es Desposteo.
//   - `reserva` antes que `circuito`: "Eliminación de reservas" no es un
//     circuito aunque ambos vivan en el mismo expediente.
//   - los objetos (detectados por `accion`) antes que los expedientes
//     (detectados por `tipo`): si no, todo caeria en Campaña/Propuesta.
//
// Nota: no hay modulo "Autorización". Autorizar es un VERBO y vive en el eje
// CATEGORIAS; los eventos de filtro DCM/DG se clasifican por su objeto real,
// que casi siempre es Circuito. Asi "Circuito + Autorización" dice mas que
// "Autorización" a secas.
export const MODULOS: Regla[] = [
  {
    value: 'prueba_color', label: 'Prueba de color', grupo: 'Artes y producción',
    patrones: accionContiene('prueba de color'),
  },
  {
    value: 'desposteo', label: 'Desposteo', grupo: 'Operaciones SAP',
    patrones: [...tipoEs('Desposteo'), ...accionContiene('desposteo')],
  },
  {
    value: 'aps', label: 'APS', grupo: 'Operaciones SAP',
    // Nada de contains 'aps' a secas: pegaria en nombres de circuito como
    // "CHIAPAS-12". Solo las frases reales: 'POST APS a SAP', 'Cancelar POST
    // APS', 'Remoción de APS', 'Asignación/Cancelar APS Pre Factura',
    // 'POST a SAP en campaña', 'desposteo APS 123'.
    patrones: accionContiene('post aps', 'de aps', 'aps pre', ' aps ', 'a sap'),
  },
  {
    value: 'actividad_comercial', label: 'Actividad comercial', grupo: 'CRM y soporte',
    patrones: [...accionContiene('actividad comercial'), ...tipoEs('Tarea')],
  },
  {
    value: 'capa_mapa', label: 'Capa de mapa', grupo: 'Mapa',
    patrones: tipoEs('capa_mapa'),
  },
  {
    value: 'reserva', label: 'Reserva', grupo: 'Inventario y espacios',
    patrones: accionContiene('reserva'),
  },
  {
    value: 'circuito', label: 'Circuito', grupo: 'Inventario y espacios',
    // Los tipos autorizacion_nueva_cara_* / autorizacion_cambio_* son siempre
    // sobre circuitos aunque el texto no siempre lo diga.
    patrones: [
      ...accionContiene('circuito'),
      ...tipoEmpieza('autorizacion_nueva_cara', 'autorizacion_cambio'),
    ],
  },
  {
    value: 'arte', label: 'Arte', grupo: 'Artes y producción',
    // Cubre 'Arte', 'Arte Digital' y 'Arte Tradicional'.
    patrones: tipoEmpieza('Arte'),
  },
  {
    value: 'instalacion', label: 'Instalación', grupo: 'Artes y producción',
    patrones: tipoEs('Instalación', 'Instalacion'),
  },
  {
    value: 'inventario', label: 'Inventario', grupo: 'Inventario y espacios',
    patrones: tipoEs('inventario', 'Inventario'),
  },
  {
    value: 'usuario', label: 'Usuario', grupo: 'Administración',
    patrones: tipoEs('usuario'),
  },
  {
    value: 'cliente', label: 'Cliente', grupo: 'CRM y soporte',
    patrones: tipoEs('cliente', 'cliente_sync_sap'),
  },
  {
    value: 'proveedor', label: 'Proveedor', grupo: 'CRM y soporte',
    patrones: tipoEs('proveedor'),
  },
  {
    value: 'ticket', label: 'Ticket', grupo: 'CRM y soporte',
    patrones: tipoEs('ticket'),
  },
  {
    value: 'nota', label: 'Nota manual', grupo: 'Administración',
    patrones: accionEs('Acción registrada', 'Accion registrada'),
  },
  // Expedientes: ultimo recurso, cuando la accion no revela un objeto propio.
  {
    value: 'campana', label: 'Campaña', grupo: 'Flujo comercial',
    patrones: [...tipoEs('Campaña', 'campana'), ...tipoEmpieza('autorizacion_solicitud_campana', 'autorizacion_rechazo_campana')],
  },
  {
    value: 'propuesta', label: 'Propuesta', grupo: 'Flujo comercial',
    patrones: tipoEs('Propuesta', 'propuesta'),
  },
  {
    value: 'solicitud', label: 'Solicitud', grupo: 'Flujo comercial',
    patrones: [...tipoEs('Solicitud'), ...tipoEmpieza('autorizacion_solicitud')],
  },
  {
    // Ultimo recurso para el flujo de filtros DCM/DG: los tipos genericos
    // 'autorizacion_aprobacion' / 'autorizacion_rechazo' no dicen sobre que
    // expediente ni que objeto recayo la firma ("Aprobación DCM por Jos").
    // Los que si mencionan circuito ya los tomo la regla `circuito`, y los
    // que traen el expediente en el tipo los tomaron `campana`/`solicitud`.
    // Esto es el EXPEDIENTE del filtro, no el verbo: autorizar vive en
    // CATEGORIAS.
    value: 'autorizacion', label: 'Filtro de autorización', grupo: 'Flujo comercial',
    patrones: tipoEmpieza('autorizacion'),
  },
];

// -------------------------------------------------------------------------
// CATEGORIAS — en ORDEN DE PRIORIDAD.
// -------------------------------------------------------------------------
// Casos que justifican el orden:
//   - `rechazo` antes que `autorizacion`: "rechazó la eliminación" y
//     "Rechazo DCM por X" contienen ambos conceptos.
//   - `autorizacion` antes que `eliminacion`: "aprobó la eliminación de 5
//     circuito(s)" es una autorizacion, no una eliminacion.
//   - `cambio_estado` antes que `edicion`: 'Cambio de estado' y "Cambió
//     status de ticket" son estados; "cambió Caras de 2 → 4" es una edicion.
//   - `desposteo` primero: "Filtro GC rechazo desposteo APS" menciona rechazo
//     pero el flujo de desposteo es su propia categoria.
export const CATEGORIAS: Regla[] = [
  {
    value: 'desposteo', label: 'Desposteo', grupo: 'Operaciones',
    patrones: accionContiene('desposteo'),
  },
  {
    value: 'posteo', label: 'Posteo a SAP', grupo: 'Operaciones',
    patrones: accionContiene('post aps', 'post a sap', 'cancelar post'),
  },
  {
    value: 'solicitud_autorizacion', label: 'Solicitud de autorización', grupo: 'Autorizaciones',
    patrones: accionContiene('solicitó autorización', 'solicito autorizacion'),
  },
  {
    value: 'rechazo', label: 'Rechazo', grupo: 'Autorizaciones',
    patrones: accionContiene('echaz', 'devolvió para corrección', 'devolvio para correccion'),
  },
  {
    value: 'liberacion', label: 'Liberación', grupo: 'Inventario',
    patrones: [...accionContiene('iberaci', 'iberadas', 'iberados'), ...accionEs('Liberada')],
  },
  {
    value: 'cambio_estado', label: 'Cambio de estado', grupo: 'Flujo',
    patrones: [
      ...accionEs('Cambio de estado', 'Pasó a ventas', 'Vendida', 'Reservada', 'Atendida', 'Activación', 'Finalización'),
      ...accionContiene('cambió status', 'cambio status'),
    ],
  },
  {
    value: 'autorizacion', label: 'Autorización', grupo: 'Autorizaciones',
    // 'probaci' cubre Aprobación/aprobacion; 'probó'/'probo ' el verbo;
    // 'probada' los estados ("Campaña aprobada"). 'escalado' es el paso de
    // DCM a DG, que es parte del mismo flujo de autorizacion.
    patrones: accionContiene('probaci', 'probó', 'probo ', 'probada', 'probado', 'escalado'),
  },
  {
    value: 'eliminacion', label: 'Eliminación', grupo: 'Cambios',
    patrones: accionContiene('liminaci', 'liminó', 'limino ', 'emoci', 'emovió'),
  },
  {
    value: 'creacion', label: 'Creación', grupo: 'Cambios',
    patrones: [
      ...accionContiene('reaci', 'creó', 'creo ', 'creada', 'creado', 'agregó', 'agrego ', 'adición', 'adicion'),
      ...accionEs('Inicio'),
    ],
  },
  {
    value: 'edicion', label: 'Edición', grupo: 'Cambios',
    patrones: accionContiene('dici', 'ditó', 'edito ', 'editada', 'ctualiz', 'odific', 'cambió ', 'cambio de'),
  },
  {
    value: 'asignacion', label: 'Asignación', grupo: 'Flujo',
    patrones: accionContiene('signaci', 'signó', 'signo ', 'easign'),
  },
  {
    value: 'comentario', label: 'Comentario', grupo: 'Flujo',
    patrones: accionContiene('coment', 'espondió', 'espondio '),
  },
  {
    value: 'revision', label: 'Revisión', grupo: 'Artes',
    patrones: [...accionContiene('evisi'), ...accionEs('Validación', 'Rotación', 'Limpieza', 'Pendiente')],
  },
];

/** Valor de descarte cuando ninguna regla matchea. */
export const SIN_CLASIFICAR = 'otro';

export const MODULO_OTRO: Regla = {
  value: SIN_CLASIFICAR, label: 'Sin clasificar', grupo: 'Otros', patrones: [],
};
export const CATEGORIA_OTRA: Regla = {
  value: SIN_CLASIFICAR, label: 'Otro', grupo: 'Otros', patrones: [],
};

// -------------------------------------------------------------------------
// Evaluador JS
// -------------------------------------------------------------------------

/** Minusculas y sin diacriticos, para emular la collation de MySQL. */
const norm = (s: string): string =>
  (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function patronMatchea(pat: Patron, tipo: string, accion: string): boolean {
  const campo = norm(pat.campo === 'tipo' ? tipo : accion);
  const valor = norm(pat.valor);
  switch (pat.op) {
    case 'equals': return campo === valor;
    case 'startsWith': return campo.startsWith(valor);
    case 'contains': return campo.includes(valor);
  }
}

const reglaMatchea = (r: Regla, tipo: string, accion: string): boolean =>
  r.patrones.some(pat => patronMatchea(pat, tipo, accion));

/** Clasifica una fila del historial en los tres ejes. */
export function clasificar(
  tipo: string | null,
  accion: string | null,
): { etapa: string; modulo: string; categoria: string } {
  const t = tipo ?? '';
  const a = accion ?? '';
  return {
    etapa: ETAPAS.find(r => reglaMatchea(r, t, a))?.value ?? SIN_ETAPA,
    modulo: MODULOS.find(r => reglaMatchea(r, t, a))?.value ?? SIN_CLASIFICAR,
    categoria: CATEGORIAS.find(r => reglaMatchea(r, t, a))?.value ?? SIN_CLASIFICAR,
  };
}

// -------------------------------------------------------------------------
// Traductor a Prisma
// -------------------------------------------------------------------------

type Cond = Record<string, unknown>;

const condDePatron = (pat: Patron): Cond => ({
  [pat.campo]: pat.op === 'equals' ? pat.valor : { [pat.op]: pat.valor },
});

/**
 * Condicion que cumple una regla: OR de sus patrones.
 * Para `otro` (sin patrones) seria "ninguna de las demas reglas", que es un
 * NOT gigante; se resuelve en `whereDe`.
 */
const condDeRegla = (r: Regla): Cond => ({ OR: r.patrones.map(condDePatron) });

/**
 * Traduce los valores seleccionados a una condicion Prisma (OR entre ellos).
 * Devuelve null si no hay seleccion valida, para no agregar un filtro vacio.
 *
 * Ojo con la prioridad: una fila pertenece a la PRIMERA regla que matchea, asi
 * que para seleccionar la regla i hay que exigir ademas que no matchee ninguna
 * anterior. Sin eso, filtrar "Circuito" traeria tambien las reservas, porque
 * "Eliminación de reservas en circuito X" matchea las dos.
 */
export function whereDe(reglas: Regla[], seleccion: string[], valorDescarte = SIN_CLASIFICAR): Cond | null {
  const vals = new Set(seleccion);
  if (vals.size === 0) return null;

  const ors: Cond[] = [];
  for (let i = 0; i < reglas.length; i++) {
    if (!vals.has(reglas[i].value)) continue;
    const previas = reglas.slice(0, i).map(condDeRegla);
    ors.push(previas.length > 0
      ? { AND: [condDeRegla(reglas[i]), { NOT: { OR: previas } }] }
      : condDeRegla(reglas[i]));
  }

  // El valor de descarte = no matchea ninguna regla.
  if (vals.has(valorDescarte)) {
    ors.push({ NOT: { OR: reglas.map(condDeRegla) } });
  }

  return ors.length > 0 ? { OR: ors } : null;
}

export const whereModulos = (seleccion: string[]) => whereDe(MODULOS, seleccion);
export const whereCategorias = (seleccion: string[]) => whereDe(CATEGORIAS, seleccion);
export const whereEtapas = (seleccion: string[]) => whereDe(ETAPAS, seleccion, SIN_ETAPA);

// -------------------------------------------------------------------------
// Listas para los dropdowns del front
// -------------------------------------------------------------------------

/** Orden de las secciones en el dropdown (distinto del orden de prioridad). */
const ORDEN_GRUPOS_MODULO = [
  'Flujo comercial', 'Inventario y espacios', 'Artes y producción',
  'Operaciones SAP', 'Mapa', 'CRM y soporte', 'Administración', 'Otros',
];
const ORDEN_GRUPOS_CATEGORIA = [
  'Cambios', 'Autorizaciones', 'Flujo', 'Inventario', 'Operaciones', 'Artes', 'Otros',
];

export interface OpcionTaxonomia {
  value: string;
  label: string;
  grupo: string;
}

function paraDropdown(reglas: Regla[], extra: Regla, ordenGrupos: string[]): OpcionTaxonomia[] {
  const idx = (g: string) => {
    const i = ordenGrupos.indexOf(g);
    return i === -1 ? ordenGrupos.length : i;
  };
  return [...reglas, extra]
    .map(({ value, label, grupo }) => ({ value, label, grupo }))
    .sort((a, b) => idx(a.grupo) - idx(b.grupo) || a.label.localeCompare(b.label, 'es'));
}

/** Las 3 etapas en orden de flujo (no alfabetico) + "fuera del flujo". */
export const opcionesEtapas = (): OpcionTaxonomia[] =>
  [...ETAPAS, ETAPA_NINGUNA].map(({ value, label, grupo }) => ({ value, label, grupo }))
    .sort((a, b) => {
      const orden = ['solicitud', 'propuesta', 'campana', SIN_ETAPA];
      return orden.indexOf(a.value) - orden.indexOf(b.value);
    });

export const opcionesModulos = (): OpcionTaxonomia[] =>
  paraDropdown(MODULOS, MODULO_OTRO, ORDEN_GRUPOS_MODULO);

export const opcionesCategorias = (): OpcionTaxonomia[] =>
  paraDropdown(CATEGORIAS, CATEGORIA_OTRA, ORDEN_GRUPOS_CATEGORIA);
