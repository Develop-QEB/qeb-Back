// Deteccion de conflictos de ocupacion DISPARADA por el evento de reservar.
//
// Cada creacion de reserva registra aqui el inventario afectado; tras un
// debounce corto se corre UNA verificacion acotada a los sitios acumulados
// (detectarConflictos con ids tarda milisegundos, no es el barrido completo).
// Lo que aparezca pasa por la misma tabla de estado y el mismo digest que el
// monitor horario, asi que un duplicado o choque creado a media jornada avisa
// en ~medio minuto en vez de esperar a la siguiente corrida.
//
// Es un OBSERVADOR: se cuelga despues del insert y nunca interviene en la ruta
// de reservas. Si truena, la reserva ya quedo creada y no se afecta.

import { ejecutarMonitorConflictos } from './conflictos-ocupacion.service';

/** Espera tras la ultima reserva de una rafaga antes de verificar. Una campaña
 *  crea decenas de reservas seguidas; esto las junta en una sola corrida. */
const DEBOUNCE_MS = 20_000;
/** Tope: aunque la rafaga siga (campañas grandes en lotes), se verifica a mas
 *  tardar a los 2 min de la primera reserva pendiente. Lo que llegue despues
 *  abre su propio ciclo. */
const MAX_ESPERA_MS = 120_000;

const pendientes = new Set<number>();
let timer: ReturnType<typeof setTimeout> | null = null;
let primeraPendiente = 0;
let corriendo = false;

/**
 * Registrar que se creo una reserva sobre este inventario (id de `inventarios`,
 * no del espacio). Barato y sincrono: un Set y un timer.
 */
export function registrarReservaCreada(inventarioId: number | null | undefined): void {
  const id = Number(inventarioId);
  if (!Number.isInteger(id) || id <= 0) return;

  const ahora = Date.now();
  if (pendientes.size === 0) primeraPendiente = ahora;
  pendientes.add(id);

  // Debounce clasico (cada reserva pospone la corrida) pero con tope duro para
  // que un goteo continuo no la posponga indefinidamente.
  if (timer) clearTimeout(timer);
  const restanteAlTope = Math.max(1_000, MAX_ESPERA_MS - (ahora - primeraPendiente));
  timer = setTimeout(() => { void verificarPendientes(); }, Math.min(DEBOUNCE_MS, restanteAlTope));
}

async function verificarPendientes(): Promise<void> {
  timer = null;
  if (pendientes.size === 0) return;
  if (corriendo) {
    // Ya hay una verificacion en vuelo; lo pendiente espera al siguiente ciclo.
    timer = setTimeout(() => { void verificarPendientes(); }, DEBOUNCE_MS);
    return;
  }

  const ids = [...pendientes];
  pendientes.clear();
  corriendo = true;
  try {
    // Catorcenas vigentes (default) + solo los sitios de la rafaga. Notifica
    // con el mismo digest del monitor; como corre dentro del proceso del
    // servidor, el popup por socket sale en vivo.
    const r = await ejecutarMonitorConflictos({ ids });
    if (r.nuevos > 0 || r.resueltos > 0) {
      console.log(`[ConflictosLive] ${ids.length} sitio(s) tras reservar: nuevos=${r.nuevos} (choque=${r.nuevosChoque} dup=${r.nuevosDuplicado}) resueltos=${r.resueltos} avisados=${r.notificados}`);
    }
  } catch (err) {
    console.error('[ConflictosLive] Error verificando tras reserva:', err);
  } finally {
    corriendo = false;
    // Lo que se registro mientras corriamos programa su propia corrida.
    if (pendientes.size > 0 && !timer) {
      primeraPendiente = Date.now();
      timer = setTimeout(() => { void verificarPendientes(); }, DEBOUNCE_MS);
    }
  }
}
