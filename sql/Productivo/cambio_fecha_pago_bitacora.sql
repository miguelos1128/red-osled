ALTER TABLE bitacora_servicio
MODIFY COLUMN tipo_evento ENUM('falta_pago','decision_usuario','falla_tecnica','cambio_fecha_pago','cambio_paquete') NOT NULL;
