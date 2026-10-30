-- =============================================================================
-- Migración: columna solicitud.updated_at
-- =============================================================================
-- La tabla `solicitud` NO tiene columna de última modificación (solo `fecha`,
-- la de creación). La Vista Tablero de Solicitudes muestra la fecha de última
-- edición en cada tarjeta y ordena con "último cambio arriba"; sin esta
-- columna la fecha sale "—" y ese orden no puede aplicarse.
--
-- Misma receta que migration_campania_updated_at.sql (3 pasos, ver cada uno).
-- CORRER PRIMERO EN DEV.
--
-- *** DIFERENCIA IMPORTANTE CON CAMPAÑAS ***
-- El listado de solicitudes NO usa SQL crudo con `s.*`: usa
-- `prisma.solicitud.findMany` (solicitudes.controller.getAll), y Prisma solo
-- devuelve los campos que están en el schema. Así que aquí la columna NO llega
-- sola al front: después de correr esto en DEV **y** PROD hay que hacer el
-- paso 4 (schema.prisma). Ver abajo.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Paso 1. Agregar la columna SIN default, para que las solicitudes existentes
-- queden en NULL y no todas selladas con la hora del ALTER.
-- ---------------------------------------------------------------------------
ALTER TABLE solicitud
  ADD COLUMN updated_at TIMESTAMP NULL DEFAULT NULL
    ON UPDATE CURRENT_TIMESTAMP
    AFTER sap_database;

-- ---------------------------------------------------------------------------
-- Paso 2. Backfill con la fecha de creación: es la única fecha propia que
-- tiene la solicitud. Semilla hasta que cada una se toque por primera vez.
-- ---------------------------------------------------------------------------
UPDATE solicitud
   SET updated_at = fecha
 WHERE updated_at IS NULL;

-- ---------------------------------------------------------------------------
-- Paso 3. Default para las solicitudes NUEVAS. Va después del backfill porque
-- cambiar el DEFAULT no toca valores ya escritos.
-- ---------------------------------------------------------------------------
ALTER TABLE solicitud
  MODIFY COLUMN updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP
    ON UPDATE CURRENT_TIMESTAMP;

-- =============================================================================
-- Paso 4 (código, NO SQL) — SOLO cuando la columna ya exista en DEV y en PROD
-- =============================================================================
-- En qeb-Back/prisma/schema.prisma, model `solicitud`, agregar:
--
--     updated_at       DateTime? @default(now()) @db.Timestamp(0)
--
-- y correr `npx prisma generate`. A partir de ahí findMany la devuelve y el
-- front (tipo Solicitud.updated_at) la pinta y ordena.
--
-- ¿Por qué no agregarla al schema desde ya? Porque findMany haría SELECT de
-- esa columna en TODOS los ambientes, y en el que todavía no exista el
-- listado de solicitudes truena completo. El orden correcto es: SQL en DEV,
-- SQL en PROD, y hasta entonces el schema.
--
-- Nota: `prisma.solicitud.update(...)` seguirá sin escribirla explícitamente y
-- no hace falta: el ON UPDATE de MySQL la sella en cualquier UPDATE de la fila.
--
-- =============================================================================
-- Verificación
-- =============================================================================
--    SHOW COLUMNS FROM solicitud LIKE 'updated_at';
--    SELECT COUNT(*) AS sin_fecha FROM solicitud WHERE updated_at IS NULL;  -- debe dar 0
--
-- Rollback:
--    ALTER TABLE solicitud DROP COLUMN updated_at;
-- =============================================================================
