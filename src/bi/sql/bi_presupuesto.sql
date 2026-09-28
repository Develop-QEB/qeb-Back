-- Tabla NUEVA y aislada para la meta mensual editable (el "lapicito" del BI).
-- No toca ninguna tabla productiva. Córrela una vez, o deja que el back la cree
-- automáticamente con BI_ALLOW_CREATE=true.
CREATE TABLE IF NOT EXISTS `bi_presupuesto` (
  `anio`  INT          NOT NULL,
  `mes`   TINYINT      NOT NULL,               -- 1-12
  `base`  VARCHAR(10)  NOT NULL DEFAULT 'ALL', -- 'ALL' | 'CIMU' | 'TRADE' | 'SAP'
  `monto` DECIMAL(19,2) NOT NULL DEFAULT 0,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`anio`, `mes`, `base`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
