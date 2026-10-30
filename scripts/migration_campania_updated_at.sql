-- =============================================================================
-- Migración: columna campania.updated_at
-- =============================================================================
-- La tabla `campania` NO tiene columna de última modificación. El tipo
-- Campana del front declara `updated_at`, pero en el listado llega vacía: el
-- back solo la rellena en getById, y con el `updated_at` de la PROPUESTA
-- ligada, no de la campaña. Además, cambiar el estatus de una campaña
-- (campanas.controller.updateStatus) hace `update({ data: { status } })`, que
-- no toca ninguna fecha.
--
-- Motivo: la Vista Tablero de Campañas muestra la fecha de última edición en
-- cada tarjeta y ordena con "último cambio arriba". Sin esta columna la fecha
-- sale "—" y ese orden no puede aplicarse.
--
-- Por qué ON UPDATE CURRENT_TIMESTAMP y no código: MySQL sella la columna solo
-- en CUALQUIER UPDATE de la fila, así que no hay que tocar los ~10 lugares del
-- controller que actualizan campañas ni arriesgar que uno se olvide. Nota: si
-- un UPDATE escribe el mismo valor que ya tenía, MySQL no modifica la fila y la
-- fecha no cambia — correcto, porque nada cambió de verdad.
--
-- Son 3 pasos a propósito (ver comentario de cada uno). CORRER PRIMERO EN DEV.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Paso 1. Agregar la columna SIN default.
--
-- Nace como NULL DEFAULT NULL para que las campañas existentes queden en NULL
-- en vez de quedar todas selladas con la hora del ALTER. Si se agregara ya con
-- DEFAULT CURRENT_TIMESTAMP, MySQL rellenaría las filas existentes con "ahora"
-- y las ~N campañas históricas se verían como editadas hoy — una fecha falsa, y
-- el orden por "último cambio" nacería inservible.
-- ---------------------------------------------------------------------------
ALTER TABLE campania
  ADD COLUMN updated_at TIMESTAMP NULL DEFAULT NULL
    ON UPDATE CURRENT_TIMESTAMP
    AFTER prefactura_aps;

-- ---------------------------------------------------------------------------
-- Paso 2. Backfill con la mejor fecha disponible.
--
-- Mismo criterio con el que el backend ya ordena el listado de campañas
-- (ORDER BY COALESCE(cm.fecha_aprobacion, cm.fecha_inicio) DESC), así que el
-- tablero arranca con un orden coherente con lo que el usuario ya veía.
-- No pretende ser la fecha real de edición: es la semilla hasta que cada
-- campaña se toque por primera vez.
-- ---------------------------------------------------------------------------
UPDATE campania
   SET updated_at = COALESCE(fecha_aprobacion, fecha_inicio)
 WHERE updated_at IS NULL;

-- ---------------------------------------------------------------------------
-- Paso 3. Ahora sí, default para las campañas NUEVAS.
--
-- Va después del backfill: cambiar el DEFAULT no toca los valores ya escritos
-- (un default solo aplica a INSERTs nuevos), así que las fechas sembradas en el
-- paso 2 se conservan. Sin este paso, una campaña recién creada nacería con
-- updated_at NULL y la tarjeta mostraría "—" hasta su primera edición.
-- ---------------------------------------------------------------------------
ALTER TABLE campania
  MODIFY COLUMN updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP
    ON UPDATE CURRENT_TIMESTAMP;

-- =============================================================================
-- Verificación
-- =============================================================================
-- 1) La columna quedó con los dos automatismos (Default y "on update"):
--
--    SHOW COLUMNS FROM campania LIKE 'updated_at';
--    -- Default: CURRENT_TIMESTAMP   Extra: DEFAULT_GENERATED on update CURRENT_TIMESTAMP
--
-- 2) No quedaron campañas sin fecha (solo las que no tienen ni fecha_inicio):
--
--    SELECT COUNT(*) AS sin_fecha FROM campania WHERE updated_at IS NULL;
--
-- 3) El sellado automático funciona (en DEV, con un id de prueba):
--
--    SELECT id, status, updated_at FROM campania WHERE id = <ID_PRUEBA>;
--    UPDATE campania SET status = status WHERE id = <ID_PRUEBA>;  -- no cambia nada: la fecha NO debe moverse
--    SELECT id, status, updated_at FROM campania WHERE id = <ID_PRUEBA>;
--
-- =============================================================================
-- Notas
-- =============================================================================
-- * NO hace falta tocar el backend. El listado de campañas arma su SELECT con
--   `cm.*` (campanas.controller, dataQuery), así que la columna empieza a
--   viajar al front sola en cuanto exista.
--
-- * NO agregar `updated_at` al model `campania` de prisma/schema.prisma hasta
--   que la columna exista en DEV **y** en PROD. Prisma devuelve todos los
--   campos del model en `prisma.campania.update(...)`, y en el entorno donde
--   falte la columna ese SELECT truena. Mientras no esté en el schema, Prisma
--   simplemente la ignora y MySQL la sella igual.
--
-- * Rollback:
--     ALTER TABLE campania DROP COLUMN updated_at;
-- =============================================================================
