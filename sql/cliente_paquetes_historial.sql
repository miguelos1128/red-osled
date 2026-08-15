CREATE TABLE IF NOT EXISTS cliente_paquetes_historial (
    id INT AUTO_INCREMENT PRIMARY KEY,
    cliente_id INT NOT NULL,
    paquete_id INT NOT NULL,
    costo_mensual DECIMAL(10, 2) NOT NULL,
    fecha_inicio DATE NOT NULL,
    fecha_fin DATE NULL,
    usuario_id INT NULL,
    fecha_registro DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_cliente_paquetes_cliente (cliente_id),
    INDEX idx_cliente_paquetes_paquete (paquete_id),
    INDEX idx_cliente_paquetes_periodo (cliente_id, fecha_inicio, fecha_fin),
    CONSTRAINT fk_cliente_paquetes_cliente
        FOREIGN KEY (cliente_id) REFERENCES clientes(id),
    CONSTRAINT fk_cliente_paquetes_paquete
        FOREIGN KEY (paquete_id) REFERENCES paquetes(id),
    CONSTRAINT fk_cliente_paquetes_usuario
        FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
);

INSERT INTO cliente_paquetes_historial
    (cliente_id, paquete_id, costo_mensual, fecha_inicio, fecha_fin, usuario_id)
SELECT
    c.id,
    c.paquete_id,
    c.costo_mensual,
    CASE
        WHEN c.fecha_instalacion IS NULL THEN CURRENT_DATE()
        WHEN CAST(c.fecha_instalacion AS CHAR) IN ('', '0000-00-00', '0000-00-00 00:00:00') THEN CURRENT_DATE()
        ELSE DATE(c.fecha_instalacion)
    END,
    NULL,
    NULL
FROM clientes c
LEFT JOIN cliente_paquetes_historial h ON h.cliente_id = c.id
WHERE h.id IS NULL
  AND c.paquete_id IS NOT NULL;
