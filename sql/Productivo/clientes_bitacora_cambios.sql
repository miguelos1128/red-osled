CREATE TABLE IF NOT EXISTS clientes_bitacora_cambios (
    id INT NOT NULL AUTO_INCREMENT,
    cliente_id INT NOT NULL,
    usuario_id INT NULL,
    campo VARCHAR(64) NOT NULL,
    etiqueta VARCHAR(100) NULL,
    valor_anterior TEXT NULL,
    valor_nuevo TEXT NULL,
    origen VARCHAR(50) NOT NULL DEFAULT 'edicion_cliente',
    ip VARCHAR(64) NULL,
    fecha_cambio DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    INDEX idx_cliente_fecha (cliente_id, fecha_cambio),
    INDEX idx_usuario_fecha (usuario_id, fecha_cambio),
    INDEX idx_campo (campo)
);

SET @existe_grupo_cambio_id := (
    SELECT COUNT(*)
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'clientes_bitacora_cambios'
      AND COLUMN_NAME = 'grupo_cambio_id'
);

SET @sql_grupo_cambio_id := IF(
    @existe_grupo_cambio_id = 0,
    'ALTER TABLE clientes_bitacora_cambios ADD COLUMN grupo_cambio_id VARCHAR(36) NULL AFTER id',
    'SELECT 1'
);

PREPARE stmt_grupo_cambio_id FROM @sql_grupo_cambio_id;
EXECUTE stmt_grupo_cambio_id;
DEALLOCATE PREPARE stmt_grupo_cambio_id;

UPDATE clientes_bitacora_cambios
SET grupo_cambio_id = MD5(CONCAT_WS('|',
    cliente_id,
    COALESCE(usuario_id, ''),
    COALESCE(origen, ''),
    COALESCE(ip, ''),
    DATE_FORMAT(fecha_cambio, '%Y-%m-%d %H:%i:%s')
))
WHERE grupo_cambio_id IS NULL;

ALTER TABLE clientes_bitacora_cambios
    MODIFY grupo_cambio_id VARCHAR(36) NOT NULL;

SET @existe_idx_grupo_cambio := (
    SELECT COUNT(*)
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'clientes_bitacora_cambios'
      AND INDEX_NAME = 'idx_grupo_cambio'
);

SET @sql_idx_grupo_cambio := IF(
    @existe_idx_grupo_cambio = 0,
    'ALTER TABLE clientes_bitacora_cambios ADD INDEX idx_grupo_cambio (grupo_cambio_id)',
    'SELECT 1'
);

PREPARE stmt_idx_grupo_cambio FROM @sql_idx_grupo_cambio;
EXECUTE stmt_idx_grupo_cambio;
DEALLOCATE PREPARE stmt_idx_grupo_cambio;
