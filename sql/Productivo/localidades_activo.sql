ALTER TABLE localidades
ADD COLUMN activo TINYINT(1) NOT NULL DEFAULT 1 AFTER codigo_localidad;

