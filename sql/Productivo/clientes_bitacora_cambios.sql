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
