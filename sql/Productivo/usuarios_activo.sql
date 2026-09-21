SET @add_usuario_activo = (
    SELECT IF(
        COUNT(*) = 0,
        'ALTER TABLE usuarios ADD COLUMN activo TINYINT(1) NOT NULL DEFAULT 1 AFTER rol_id',
        'SELECT ''usuarios.activo already exists'''
    )
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'usuarios'
      AND COLUMN_NAME = 'activo'
);
PREPARE stmt FROM @add_usuario_activo;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
