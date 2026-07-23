CREATE TABLE IF NOT EXISTS aplicaciones_ajustes_servicio (
    id INT AUTO_INCREMENT PRIMARY KEY,
    bitacora_id INT NOT NULL,
    cliente_id INT NOT NULL,
    pago_id INT NULL,
    mes_aplicado VARCHAR(30) NOT NULL,
    monto_aplicado DECIMAL(10, 2) NOT NULL,
    fecha_aplicacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_ajustes_bitacora (bitacora_id),
    INDEX idx_ajustes_cliente (cliente_id),
    INDEX idx_ajustes_pago (pago_id),
    CONSTRAINT fk_ajustes_bitacora
        FOREIGN KEY (bitacora_id) REFERENCES bitacora_servicio(id),
    CONSTRAINT fk_ajustes_cliente
        FOREIGN KEY (cliente_id) REFERENCES clientes(id),
    CONSTRAINT fk_ajustes_pago
        FOREIGN KEY (pago_id) REFERENCES pagos(id)
);
