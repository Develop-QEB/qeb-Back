-- =============================================================================
-- Migración: tabla de auditoría para reorganización de ocupación (feature DEV)
-- =============================================================================
-- Registra cada operación de "Revisar por campaña" que mueve reservas entre
-- circuitos-formato. Solo rol DEV puede ejecutar la operación.
-- =============================================================================

CREATE TABLE IF NOT EXISTS auditoria_reorganizacion_ocupacion (
  id              INT NOT NULL AUTO_INCREMENT,
  usuario_id      INT NOT NULL,
  usuario_nombre  VARCHAR(255) NOT NULL,
  campana_id      INT NOT NULL,
  solicitud_caras_id INT NOT NULL,
  catorcena_numero INT NOT NULL,
  catorcena_anio   INT NOT NULL,
  reservas_creadas    INT NOT NULL DEFAULT 0,
  reservas_sustituidas INT NOT NULL DEFAULT 0,
  reservas_liberadas   INT NOT NULL DEFAULT 0,
  payload_json    LONGTEXT NOT NULL,
  fecha_hora      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  INDEX idx_aro_campana (campana_id),
  INDEX idx_aro_solicitud_caras (solicitud_caras_id),
  INDEX idx_aro_usuario (usuario_id),
  INDEX idx_aro_fecha (fecha_hora)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
