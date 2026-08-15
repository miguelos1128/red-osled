SET @add_codigo_localidad = (
    SELECT IF(
        COUNT(*) = 0,
        'ALTER TABLE localidades ADD COLUMN codigo_localidad CHAR(2) NULL AFTER color',
        'SELECT ''localidades.codigo_localidad already exists'''
    )
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'localidades'
      AND COLUMN_NAME = 'codigo_localidad'
);
PREPARE stmt FROM @add_codigo_localidad;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

UPDATE localidades
SET codigo_localidad = CASE id
    WHEN 1 THEN 'JU'
    WHEN 2 THEN 'JC'
    WHEN 3 THEN 'SA'
    WHEN 4 THEN 'BA'
    WHEN 5 THEN 'SR'
    WHEN 6 THEN 'LA'
    ELSE codigo_localidad
END
WHERE id IN (1, 2, 3, 4, 5, 6);

SET @add_codigo_localidad_index = (
    SELECT IF(
        COUNT(*) = 0,
        'ALTER TABLE localidades ADD UNIQUE INDEX uk_localidades_codigo_localidad (codigo_localidad)',
        'SELECT ''uk_localidades_codigo_localidad already exists'''
    )
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'localidades'
      AND INDEX_NAME = 'uk_localidades_codigo_localidad'
);
PREPARE stmt FROM @add_codigo_localidad_index;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @add_codigo_cliente = (
    SELECT IF(
        COUNT(*) = 0,
        'ALTER TABLE clientes ADD COLUMN codigo_cliente VARCHAR(8) NULL AFTER localidad_id',
        'SELECT ''clientes.codigo_cliente already exists'''
    )
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'clientes'
      AND COLUMN_NAME = 'codigo_cliente'
);
PREPARE stmt FROM @add_codigo_cliente;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

UPDATE clientes c
JOIN (
    SELECT
        id,
        CONCAT(codigo_localidad, periodo, LPAD(consecutivo_mes, 2, '0')) AS codigo_generado
    FROM (
        SELECT
            c.id,
            l.codigo_localidad,
            DATE_FORMAT(c.fecha_instalacion, '%y%m') AS periodo,
            ROW_NUMBER() OVER (
                PARTITION BY DATE_FORMAT(c.fecha_instalacion, '%Y-%m')
                ORDER BY c.fecha_instalacion ASC, c.id ASC
            ) AS consecutivo_mes
        FROM clientes c
        JOIN localidades l ON l.id = c.localidad_id
        WHERE c.fecha_instalacion IS NOT NULL
          AND c.localidad_id IS NOT NULL
          AND l.codigo_localidad IS NOT NULL
    ) numerados
    WHERE consecutivo_mes <= 99
) codigos ON codigos.id = c.id
SET c.codigo_cliente = codigos.codigo_generado
WHERE c.codigo_cliente IS NULL OR c.codigo_cliente = '';

SET @add_codigo_cliente_index = (
    SELECT IF(
        COUNT(*) = 0,
        'ALTER TABLE clientes ADD UNIQUE INDEX uk_clientes_codigo_cliente (codigo_cliente)',
        'SELECT ''uk_clientes_codigo_cliente already exists'''
    )
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'clientes'
      AND INDEX_NAME = 'uk_clientes_codigo_cliente'
);
PREPARE stmt FROM @add_codigo_cliente_index;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SELECT DATE_FORMAT(fecha_instalacion, '%Y-%m') AS mes, COUNT(*) AS total
FROM clientes
WHERE fecha_instalacion IS NOT NULL
GROUP BY DATE_FORMAT(fecha_instalacion, '%Y-%m')
HAVING total > 99;

SELECT id, nombre_completo, fecha_instalacion, localidad_id
FROM clientes
WHERE codigo_cliente IS NULL OR codigo_cliente = '';
