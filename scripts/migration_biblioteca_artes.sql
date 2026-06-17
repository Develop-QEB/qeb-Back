-- =============================================================================
-- Migración: tabla biblioteca_artes
-- =============================================================================
-- Persiste el metadata de cada arte cargado por campaña, independiente de las
-- filas vivas en artes_tradicionales / imagenes_digitales / reservas.archivo.
--
-- Motivo: al reasignar inventarios, el back borra y reinserta filas en
-- artes_tradicionales, lo que dejaba "huérfanos" los artes anteriores y los
-- desaparecía de la "Biblioteca de artes" en el tab Subir Arte. Esta tabla
-- nunca se borra; el endpoint getArtesExistentes hace UNION con ella para que
-- los artes sigan disponibles aunque no estén asignados a ningún inventario.
--
-- Únique por (campania_id, archivo) → INSERT...ON DUPLICATE KEY UPDATE
-- desde assignArteTradicional / addArteDigital, idempotente.
-- =============================================================================

-- IMPORTANTE: COLLATE utf8mb4_general_ci en columnas string para hacer match
-- con reservas/artes_tradicionales/imagenes_digitales que tienen esa collation.
-- Sin esto el endpoint getArtesExistentes truena con "Illegal mix of collations"
-- al hacer UNION ALL con esas tablas.
CREATE TABLE IF NOT EXISTS biblioteca_artes (
  id                  INT NOT NULL AUTO_INCREMENT,
  campania_id         INT NOT NULL,
  archivo             VARCHAR(1000) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  tipo                VARCHAR(20)   CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'tradicional',
  nombre_arte         VARCHAR(255)  CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL,
  nota                TEXT          CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL,
  estatus_operaciones VARCHAR(500)  CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL,
  created_by_id       INT           NULL,
  created_at          DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_biblioteca_campania_archivo (campania_id, archivo(255)),
  INDEX idx_biblioteca_campania (campania_id),
  INDEX idx_biblioteca_tipo (tipo)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
