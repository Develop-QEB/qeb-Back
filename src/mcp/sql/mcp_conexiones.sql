-- Conexiones OAuth del MCP de QEB (ver src/mcp/oauth.ts).
-- Una fila = un usuario autorizó una aplicación (Claude, ChatGPT...) a consultar QEB.
-- Correr UNA vez por ambiente (pruebas y producción). Es una tabla nueva y aislada:
-- no toca ni referencia ninguna tabla existente.

CREATE TABLE IF NOT EXISTS mcp_conexiones (
  id                CHAR(32)     NOT NULL,
  usuario_id        INT          NOT NULL,
  client_hash       CHAR(64)     NOT NULL,           -- sha256 del client_id de la app
  client_nombre     VARCHAR(120) NULL,               -- nombre que declaró la app (no verificado)
  scope             VARCHAR(120) NOT NULL DEFAULT 'qeb.read',
  refresh_hash      CHAR(64)     NOT NULL,           -- sha256 del refresh token vigente
  refresh_prev_hash CHAR(64)     NULL,               -- el anterior, para detectar reuso
  rotado_en         DATETIME     NULL,
  creado_en         DATETIME     NOT NULL,
  ultimo_uso        DATETIME     NULL,               -- última renovación del acceso (~cada hora de uso)
  expira_en         DATETIME     NOT NULL,           -- se extiende 30 días en cada renovación
  revocado_en       DATETIME     NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_mcp_conexiones_refresh (refresh_hash),
  KEY idx_mcp_conexiones_prev (refresh_prev_hash),
  KEY idx_mcp_conexiones_usuario (usuario_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Consultas útiles ---------------------------------------------------------

-- Quién tiene qué conectado:
-- SELECT c.id, u.nombre, c.client_nombre, c.creado_en, c.ultimo_uso, c.expira_en, c.revocado_en
-- FROM mcp_conexiones c JOIN usuario u ON u.id = c.usuario_id ORDER BY c.creado_en DESC;

-- Revocar una conexión (surte efecto en máximo 1 minuto):
-- UPDATE mcp_conexiones SET revocado_en = NOW() WHERE id = '<id>';

-- Revocar todas las de un usuario:
-- UPDATE mcp_conexiones SET revocado_en = NOW() WHERE usuario_id = <id> AND revocado_en IS NULL;
