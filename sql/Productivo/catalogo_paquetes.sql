CREATE TABLE IF NOT EXISTS paquetes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nombre_paquete VARCHAR(100) NOT NULL,
    velocidad_mbps DECIMAL(6, 2) NOT NULL,
    velocidad_garantizada_mbps DECIMAL(6, 2) NOT NULL,
    costo DECIMAL(10, 2) NOT NULL,
    activo TINYINT(1) NOT NULL DEFAULT 1,
    fecha_creacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    fecha_actualizacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_paquetes_nombre (nombre_paquete)
);

INSERT INTO paquetes (nombre_paquete, velocidad_mbps, velocidad_garantizada_mbps, costo, activo)
VALUES
    ('Basico', 5, 1, 300, 1),
    ('Basico Plus', 10, 2, 400, 1),
    ('Plus', 16, 4, 600, 1)
ON DUPLICATE KEY UPDATE
    velocidad_mbps = VALUES(velocidad_mbps),
    velocidad_garantizada_mbps = VALUES(velocidad_garantizada_mbps),
    costo = VALUES(costo),
    activo = VALUES(activo);

SET @add_paquete_id = (
    SELECT IF(
        COUNT(*) = 0,
        'ALTER TABLE clientes ADD COLUMN paquete_id INT NULL AFTER paquete',
        'SELECT ''clientes.paquete_id already exists'''
    )
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'clientes'
      AND COLUMN_NAME = 'paquete_id'
);
PREPARE stmt FROM @add_paquete_id;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

ALTER TABLE clientes
MODIFY COLUMN paquete VARCHAR(100) NULL;

UPDATE clientes c
JOIN paquetes p ON (
    (UPPER(TRIM(c.paquete)) IN ('5M', '5 M', 'BASICO') AND p.nombre_paquete = 'Basico')
    OR (UPPER(TRIM(c.paquete)) IN ('8M', '8 M', '10M', '10 M', 'BASICO PLUS') AND p.nombre_paquete = 'Basico Plus')
    OR (UPPER(TRIM(c.paquete)) IN ('16M', '16 M', 'PLUS') AND p.nombre_paquete = 'Plus')
)
SET c.paquete_id = p.id
WHERE c.paquete_id IS NULL;

SET @add_paquete_index = (
    SELECT IF(
        COUNT(*) = 0,
        'ALTER TABLE clientes ADD INDEX idx_clientes_paquete_id (paquete_id)',
        'SELECT ''idx_clientes_paquete_id already exists'''
    )
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'clientes'
      AND INDEX_NAME = 'idx_clientes_paquete_id'
);
PREPARE stmt FROM @add_paquete_index;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @add_paquete_fk = (
    SELECT IF(
        COUNT(*) = 0,
        'ALTER TABLE clientes ADD CONSTRAINT fk_clientes_paquete FOREIGN KEY (paquete_id) REFERENCES paquetes(id)',
        'SELECT ''fk_clientes_paquete already exists'''
    )
    FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = DATABASE()
      AND CONSTRAINT_NAME = 'fk_clientes_paquete'
);
PREPARE stmt FROM @add_paquete_fk;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
