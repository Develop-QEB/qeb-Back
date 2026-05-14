-- =============================================================================
-- Kill-switch global de acceso a QEB
-- =============================================================================
-- Una sola fila (id=1). El authMiddleware consulta esta tabla con cache 30s.
-- Cuando acceso_restringido=1, los rol NO listados en roles_permitidos
-- reciben 503 en sus requests (efectivamente bloqueados aunque tengan JWT vivo).
--
-- Nace en 0 = dormido. Activar con UPDATE cuando quieras.
-- =============================================================================

CREATE TABLE IF NOT EXISTS system_settings (
  id                 INT AUTO_INCREMENT PRIMARY KEY,
  acceso_restringido TINYINT NOT NULL DEFAULT 0,
  roles_permitidos   VARCHAR(500) NOT NULL DEFAULT '',
  motivo             VARCHAR(500) NULL,
  updated_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Seed inicial — DORMIDO (acceso_restringido=0).
-- Whitelist preconfigurada con DEV + roles de tráfico.
INSERT INTO system_settings (id, acceso_restringido, roles_permitidos, motivo)
VALUES (
  1,
  0,
  'DEV,Especialista de trafico,Auxiliar de trafico,Gerente de Trafico',
  'QEB en mantenimiento. Solo Tráfico y DEV tienen acceso por ahora.'
)
ON DUPLICATE KEY UPDATE id = id;

-- =============================================================================
-- COMANDOS DE OPERACIÓN
-- =============================================================================

-- Activar bloqueo (a las 4pm):
-- UPDATE system_settings SET acceso_restringido = 1 WHERE id = 1;

-- Desactivar bloqueo (cuando termine):
-- UPDATE system_settings SET acceso_restringido = 0 WHERE id = 1;

-- Ajustar whitelist sin tocar código (ej. agregar Administrador):
-- UPDATE system_settings
--    SET roles_permitidos = 'DEV,Especialista de trafico,Auxiliar de trafico,Gerente de Trafico,Administrador'
--  WHERE id = 1;

-- Cambiar el mensaje que ven los bloqueados:
-- UPDATE system_settings SET motivo = 'Tu mensaje custom aquí' WHERE id = 1;

-- Ver estado actual:
-- SELECT * FROM system_settings WHERE id = 1;
