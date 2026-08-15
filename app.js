// 1. Importar librerías
const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
require('dotenv').config();

const app = express();

// Servir archivos estáticos desde la carpeta "public"
app.use(express.static('public'));

// 2. Middlewares (Configuraciones intermedias)
app.use(cors()); // Permite peticiones desde otros puertos (tu HTML)
app.use(express.json()); // Permite que el servidor entienda formato JSON

// 3. Configuración de la conexión a MySQL
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000
});

// Convertimos el pool a versión Promesas inmediatamente
const db = pool.promise();

// Exportamos para usar en otras partes del código
module.exports = db;

// VALIDACIÓN DE CONEXIÓN (Usando la sintaxis de Promesas correctamente)
db.getConnection()
    .then(connection => {
        console.log('✅ Conectado a la Base de Datos: ' + process.env.DB_NAME);
        connection.release(); // Liberar la conexión al pool
    })
    .catch(err => {
        console.error('❌ Error al conectar a MySQL: ', err.message);
    });

// 4. Rutas de prueba (Endpoints)

// Ruta básica para verificar que el servidor funciona
app.get('/', (req, res) => {
    res.send('Servidor de Pagos de Internet funcionando 🚀');
});

/* // Ejemplo: Obtener todos los clientes (Para ver si la DB responde)
app.get('/api/clientes', async (req, res) => {
    const query = 'SELECT * FROM clientes';
    try{
        const [results] = await db.query(query);
        res.json(results);    
    }catch(err){
        res.status(500).json({ error: err.message });
    }
    
}); */

app.get('/api/admin/clientes-historial', async (req, res) => {
    try {
        await finalizarAusenciasProgramadasVencidas(db);

        const rol = parseInt(req.query.rol);
        const filtroEstadoServicio = String(req.query.estado_servicio || 'todos_activos');
        let localidadesArray = [];

        if (req.query.localidades) {
            localidadesArray = req.query.localidades.split(',').map(Number);
        }

        let query = `
            SELECT
                c.id, c.codigo_cliente, c.nombre_completo, c.url_portal, c.alias_cliente, c.telefono, c.observaciones,
                c.es_renta, c.estado_servicio, bs.tipo_evento AS tipo_suspension_activa,
                bb.tipo_evento AS motivo_baja, bb.fecha_fin AS fecha_baja,
                fecha_instalacion, c.direccion_ip, c.costo_mensual, c.dia_pago, c.localidad_id,
                c.paquete_id, l.nombre AS localidad_nombre, l.codigo_localidad,
                COALESCE(paq.nombre_paquete, c.paquete) AS paquete,
                paq.nombre_paquete AS paquete_nombre,
                paq.velocidad_mbps AS paquete_velocidad_mbps,
                paq.velocidad_garantizada_mbps AS paquete_velocidad_garantizada_mbps,
                paq.costo AS paquete_costo,
                IFNULL(GROUP_CONCAT(CONCAT(p.mes_pagado, ':', p.estado_corte) SEPARATOR ','), '') as historial_pagos
            FROM clientes c
            LEFT JOIN localidades l ON l.id = c.localidad_id
            LEFT JOIN paquetes paq ON paq.id = c.paquete_id
            LEFT JOIN bitacora_servicio bs ON bs.cliente_id = c.id
                AND bs.estado = 'Activo'
            LEFT JOIN bitacora_servicio bb ON bb.id = (
                SELECT b2.id
                FROM bitacora_servicio b2
                WHERE b2.cliente_id = c.id
                  AND b2.estado = 'Finalizado'
                  AND b2.tipo_evento = 'falta_pago'
                ORDER BY COALESCE(b2.fecha_fin, b2.fecha_inicio) DESC, b2.id DESC
                LIMIT 1
            )
            LEFT JOIN pagos p ON c.id = p.cliente_id
                AND YEAR(p.fecha_pago) = YEAR(CURRENT_DATE())
        `;

        let queryParams = [];
        const condiciones = [];

        switch (filtroEstadoServicio) {
            case 'activo':
                condiciones.push("LOWER(COALESCE(c.estado_servicio, '')) = 'activo'");
                break;
            case 'suspendidos':
                condiciones.push("LOWER(COALESCE(c.estado_servicio, '')) = 'suspendido'");
                break;
            case 'falta_pago':
                condiciones.push("LOWER(COALESCE(c.estado_servicio, '')) = 'suspendido'");
                condiciones.push("bs.tipo_evento = 'falta_pago'");
                break;
            case 'decision_usuario':
                condiciones.push("LOWER(COALESCE(c.estado_servicio, '')) = 'suspendido'");
                condiciones.push("bs.tipo_evento = 'decision_usuario'");
                break;
            case 'baja':
                condiciones.push("LOWER(COALESCE(c.estado_servicio, '')) = 'baja'");
                break;
            case 'todos_activos':
            default:
                condiciones.push("LOWER(COALESCE(c.estado_servicio, '')) <> 'baja'");
                break;
        }

        if ((rol === 3 || rol === 1) && localidadesArray.length > 0) {
            const placeholders = localidadesArray.map(() => '?').join(',');
            condiciones.push(`c.localidad_id IN (${placeholders})`);
            queryParams = [...localidadesArray];
        }

        if (condiciones.length > 0) {
            query += ` WHERE ${condiciones.join(' AND ')} `;
        }

        query += `
            GROUP BY c.id, c.codigo_cliente, c.nombre_completo, c.url_portal, c.alias_cliente, c.telefono, c.observaciones,
                c.es_renta, c.estado_servicio, bs.tipo_evento, bb.tipo_evento, bb.fecha_fin,
                c.direccion_ip, c.costo_mensual, c.dia_pago, c.localidad_id, c.paquete_id,
                l.nombre, l.codigo_localidad, c.paquete, paq.nombre_paquete, paq.velocidad_mbps,
                paq.velocidad_garantizada_mbps, paq.costo
            ORDER BY c.dia_pago;
        `;

        const [clientes] = await db.query(query, queryParams);
        const clientesConEstadoCuenta = await Promise.all(clientes.map(async cliente => {
            const [pagosCliente] = await db.query(
                'SELECT mes_pagado, monto FROM pagos WHERE cliente_id = ? AND estado_corte < 3',
                [cliente.id]
            );
            const bitacoraCliente = await consultarBitacoraServicio(db, cliente.id);
            const historialPaquetes = await consultarHistorialPaquetes(db, cliente.id);
            const estadoCuenta = calcularEstadoCuentaServidor(cliente, pagosCliente, bitacoraCliente, historialPaquetes);

            return {
                ...cliente,
                adeudo_actual: estadoCuenta.adeudo_actual,
                saldo_favor: estadoCuenta.saldo_favor
            };
        }));

        res.json(clientesConEstadoCuenta);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});


app.post('/api/login', async (req, res) => {
    const { correo, password } = req.body;
    
    // Consulta 1: Verificamos credenciales
    const queryUsuario = 'SELECT id, nombre, rol_id FROM usuarios WHERE correo = ? AND password = ?';

    try {
        const [results] = await db.query(queryUsuario, [correo, password]);

        if (results.length > 0) {
            const usuario = results[0];
            
            // --- NUEVO CÓDIGO: Buscar localidades autorizadas ---
            const queryLocalidades = 'SELECT localidad_id FROM usuario_localidad WHERE usuario_id = ?';
            const [localidadesDb] = await db.query(queryLocalidades, [usuario.id]);
            
            // Transformamos el resultado [{localidad_id: 1}, {localidad_id: 3}] en un arreglo simple [1, 3]
            const localidadesPermitidas = localidadesDb.map(loc => loc.localidad_id);
            // ----------------------------------------------------

            console.log(`Usuario ${usuario.nombre} logueado. Localidades:`, localidadesPermitidas);

            // Devolvemos la info al frontend
            res.json({
                success: true,
                mensaje: "Bienvenido",
                user: {
                    id: usuario.id,
                    nombre: usuario.nombre,
                    rol: usuario.rol_id, // 1 = Cobrador, 2 = Admin
                    localidades: localidadesPermitidas // <-- ¡AQUÍ VIAJAN LOS PERMISOS!
                }
            });
        } else {
            res.status(401).json({ success: false, mensaje: "Correo o contraseña incorrectos" });
        }
    } catch (err) {
        console.error('Error en login:', err);
        res.status(500).json({ error: "Error en el servidor" });
    }
});
// 5. Iniciar el servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`📡 Servidor corriendo en http://localhost:${PORT}`);
});

async function obtenerPaqueteActivoPorId(paqueteId, ejecutor = db) {
    const id = parseInt(paqueteId, 10);
    if (!id) return null;

    const [rows] = await ejecutor.query(
        `SELECT id, nombre_paquete, velocidad_mbps, velocidad_garantizada_mbps, costo
         FROM paquetes
         WHERE id = ? AND activo = 1
         LIMIT 1`,
        [id]
    );

    return rows[0] || null;
}

function esRolAdministrador(rol) {
    return parseInt(rol, 10) === 2;
}

function validarAdministradorRequest(req, res) {
    const rol = req.body?.rol_usuario ?? req.query?.rol_usuario ?? req.query?.rol;
    if (esRolAdministrador(rol)) return true;

    res.status(403).json({
        success: false,
        error: 'Acceso denegado: solo el administrador puede usar herramientas administrativas.'
    });
    return false;
}

function normalizarDatosPaquete(body = {}) {
    const nombre = String(body.nombre_paquete || '').trim();
    const velocidad = parseFloat(body.velocidad_mbps);
    const garantizada = parseFloat(body.velocidad_garantizada_mbps);
    const costo = parseFloat(body.costo);
    const activo = body.activo === undefined ? 1 : (parseInt(body.activo, 10) ? 1 : 0);
    const errores = [];

    if (!nombre) errores.push('El nombre del paquete es obligatorio.');
    if (!Number.isFinite(velocidad) || velocidad <= 0) errores.push('La velocidad Mbps debe ser mayor a cero.');
    if (!Number.isFinite(garantizada) || garantizada < 0) errores.push('La velocidad garantizada no es valida.');
    if (Number.isFinite(velocidad) && Number.isFinite(garantizada) && garantizada > velocidad) {
        errores.push('La velocidad garantizada no puede ser mayor a la velocidad del paquete.');
    }
    if (!Number.isFinite(costo) || costo <= 0) errores.push('El costo debe ser mayor a cero.');

    return {
        datos: {
            nombre_paquete: nombre,
            velocidad_mbps: velocidad,
            velocidad_garantizada_mbps: garantizada,
            costo,
            activo
        },
        errores
    };
}

function obtenerPeriodoCodigoCliente(fechaInstalacion) {
    const fecha = crearFechaLocalDesdeValor(fechaInstalacion);
    if (!fecha) return null;

    const anio = String(fecha.getFullYear()).slice(-2);
    const mes = String(fecha.getMonth() + 1).padStart(2, '0');
    return `${anio}${mes}`;
}

function normalizarCodigoLocalidad(codigo) {
    const codigoNormalizado = String(codigo || '').trim().toUpperCase();
    return /^[A-Z0-9]{2}$/.test(codigoNormalizado) ? codigoNormalizado : null;
}

async function obtenerCodigoLocalidad(ejecutor, localidadId) {
    const [localidades] = await ejecutor.query(
        'SELECT codigo_localidad FROM localidades WHERE id = ? LIMIT 1',
        [localidadId]
    );

    if (localidades.length === 0) {
        throw new Error('La localidad seleccionada no existe.');
    }

    const codigoLocalidad = normalizarCodigoLocalidad(localidades[0].codigo_localidad);
    if (!codigoLocalidad) {
        throw new Error('La localidad seleccionada no tiene un codigo_localidad valido.');
    }

    return codigoLocalidad;
}

async function obtenerSiguienteConsecutivoCodigoCliente(ejecutor, periodo) {
    const [rows] = await ejecutor.query(
        `SELECT
            COALESCE(MAX(
                CASE
                    WHEN codigo_cliente IS NOT NULL
                     AND SUBSTRING(codigo_cliente, 3, 4) = ?
                    THEN CAST(RIGHT(codigo_cliente, 2) AS UNSIGNED)
                END
            ), 0) AS ultimo_codigo,
            COUNT(
                CASE
                    WHEN DATE_FORMAT(fecha_instalacion, '%y%m') = ?
                    THEN 1
                END
            ) AS total_mes
         FROM clientes
         WHERE DATE_FORMAT(fecha_instalacion, '%y%m') = ?
            OR (
                codigo_cliente IS NOT NULL
                AND SUBSTRING(codigo_cliente, 3, 4) = ?
            )`,
        [periodo, periodo, periodo, periodo]
    );

    const ultimoCodigo = parseInt(rows[0]?.ultimo_codigo, 10) || 0;
    const totalMes = parseInt(rows[0]?.total_mes, 10) || 0;
    const siguiente = Math.max(ultimoCodigo, totalMes) + 1;

    if (siguiente > 99) {
        throw new Error(`Ya existen 99 clientes instalados en el periodo ${periodo}.`);
    }

    return String(siguiente).padStart(2, '0');
}

async function generarCodigoCliente(ejecutor, localidadId, fechaInstalacion) {
    const periodo = obtenerPeriodoCodigoCliente(fechaInstalacion);
    if (!periodo) {
        throw new Error('La fecha de instalacion no es valida para generar el codigo de cliente.');
    }

    const codigoLocalidad = await obtenerCodigoLocalidad(ejecutor, localidadId);
    const consecutivo = await obtenerSiguienteConsecutivoCodigoCliente(ejecutor, periodo);
    return `${codigoLocalidad}${periodo}${consecutivo}`;
}

// Ruta para agregar un nuevo cliente (POST)
// Ruta actualizada para agregar un nuevo cliente
app.post('/api/clientes', async (req, res) => {
    let connection;

    try{
        // 1. Obtenemos los datos del cuerpo de la petición (req.body)
        const { 
            nombre_completo, alias_cliente, url_portal, telefono, correo, direccion, observaciones, es_renta,
            fecha_instalacion, dia_pago, direccion_ip, señal, paquete_id, costo_mensual, localidad_id, rol_usuario, usuario_id
        } = req.body;

        // 2. VALIDACIÓN DE SEGURIDAD (Bloqueo de Creación)
        // Comprobamos si el usuario NO es el Administrador (rol 2)
        if (parseInt(rol_usuario, 10) !== 2) {
            // Detenemos la ejecución y enviamos un mensaje de error al navegador
            return res.status(403).json({
                success: false,
                mensaje: "Acceso denegado: Tu rol no tiene permisos para crear clientes."
            });
        }

        const diaPagoAlta = obtenerDiaPagoDesdeFechaInstalacion(fecha_instalacion);
        if (!diaPagoAlta) {
            return res.status(400).json({
                success: false,
                error: 'La fecha de instalacion no es valida.'
            });
        }

        const paqueteSeleccionado = await obtenerPaqueteActivoPorId(paquete_id);
        if (!paqueteSeleccionado) {
            return res.status(400).json({
                success: false,
                error: 'Selecciona un paquete valido.'
            });
        }

        const costoMensual = costo_mensual === undefined || costo_mensual === null || costo_mensual === ''
            ? parseFloat(paqueteSeleccionado.costo)
            : parseFloat(costo_mensual);

        if (!Number.isFinite(costoMensual) || costoMensual <= 0) {
            return res.status(400).json({
                success: false,
                error: 'El costo mensual no es valido.'
            });
        }

        const usuarioIdAlta = parseInt(usuario_id, 10) || null;
        const query = `INSERT INTO clientes 
                    (nombre_completo, alias_cliente, url_portal, telefono, correo, direccion, observaciones, es_renta, fecha_instalacion, dia_pago, direccion_ip, \`señal\`, paquete, paquete_id, costo_mensual, localidad_id, codigo_cliente)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        console.log("Query", query);
        console.log("Datos recibidos para el nuevo cliente:", req.body);
    // 2. Abrimos el bloque try/catch
    
        connection = await db.getConnection();
        await connection.beginTransaction();
        const codigoClienteAlta = await generarCodigoCliente(connection, localidad_id, fecha_instalacion);

        // 3. Usamos 'await' y extraemos [result] (Borramos el callback)
        const [result] = await connection.query(query, [
        nombre_completo, alias_cliente, url_portal, telefono, correo, direccion, observaciones || null, es_renta ? 1 : 0,
        fecha_instalacion, diaPagoAlta, direccion_ip, señal, paqueteSeleccionado.nombre_paquete,
        paqueteSeleccionado.id, costoMensual, localidad_id, codigoClienteAlta
        ]);

        await connection.query(
            `INSERT INTO cliente_paquetes_historial
                (cliente_id, paquete_id, costo_mensual, fecha_inicio, fecha_fin, usuario_id)
             VALUES (?, ?, ?, ?, NULL, ?)`,
            [result.insertId, paqueteSeleccionado.id, costoMensual, fecha_instalacion, usuarioIdAlta]
        );

        await connection.commit();
        // 4a. Si todo sale bien, respondemos aquí
        res.json({
            success: true,
            mensaje: "Cliente creado con exito",
            codigo_cliente: codigoClienteAlta,
            cliente_id: result.insertId
        });
    }catch(error){
        if (connection) {
            try {
                await connection.rollback();
            } catch (rollbackError) {
                console.error("Error al revertir alta de cliente:", rollbackError);
            }
        }

        // 4b. Si hay un error, el 'catch' lo atrapa automáticamente
        console.error("Error al crear cliente:", error);
        if (error.code === 'ER_DUP_ENTRY' && String(error.message || '').includes('codigo_cliente')) {
            return res.status(409).json({
                success: false,
                error: 'No se pudo generar un numero de cliente unico. Intenta guardar nuevamente.'
            });
        }
        res.status(500).json({ error: "Error al guardar en la BD: " + error.message });
    } finally {
        if (connection) connection.release();
    }
});

// Ruta para buscar clientes por nombre o numero de cliente
// 1. Agregamos async aquí
app.get('/api/buscar-clientes', async (req, res) => {
    try {
        const term = String(req.query.q || '').trim(); // Lo que el cliente escribe
        if (term.length < 2) return res.json([]);
        // 1. Recibimos el "gafete" del frontend desde la URL
        const rol = parseInt(req.query.rol);
        // Convertimos el texto "[1,3]" de vuelta a un arreglo real de Javascript [1, 3]
        let localidadesPermitidas = [];
        if (req.query.localidades) {
            localidadesPermitidas = JSON.parse(req.query.localidades);
        }
        
        // 2. Preparamos la consulta base
        let query = `
            SELECT id, codigo_cliente, nombre_completo, alias_cliente, telefono, direccion_ip, costo_mensual, fecha_instalacion, dia_pago, estado_servicio
            FROM clientes
            WHERE (nombre_completo LIKE ? OR codigo_cliente LIKE ?)
            `;
        let params = [`%${term}%`, `%${term}%`]

        // 3. LA MAGIA: Aplicamos el filtro si NO es Administrador (Asumiendo que Admin es rol 2)
        if (rol !== 2) { 
            if (localidadesPermitidas.length > 0) {
                // Filtramos solo por las localidades permitidas usando IN (?)
                query += '  AND localidad_id IN (?)';
                params.push(localidadesPermitidas);
            } else {
                // Medida de seguridad: Si es cobrador pero no le han asignado localidades, devolvemos una lista vacía
                return res.json([]); 
            }
        }

        query += ` ORDER BY nombre_completo ASC LIMIT 10`;

        console.log("query" + query+ " params "+params)
        // 3. Hacemos el await y destructuramos [results]. Mantenemos tus variables dinámicas intactas.
        const [results] = await db.query(query, params);
        
        // 4. Si todo va bien, enviamos el resultado
        res.json(results);

    } catch (error) {
        // Manejamos el error en el catch
        console.error("Error al buscar clientes:", error);
        res.status(500).json({ error: "Error interno al realizar la búsqueda en la base de datos" });
    }
});


// Ruta para obtener el historial de los últimos 6 pagos de un cliente
app.get('/api/clientes/:id/historial-pagos', async (req, res) => {
    const clienteId = req.params.id;

    
    // Hacemos un JOIN con 'usuarios' para obtener el nombre de quien cobró
    const query = `
        SELECT p.fecha_pago, p.mes_pagado, p.monto, u.nombre AS cobrador 
        FROM pagos p
        LEFT JOIN usuarios u ON p.usuario_id = u.id
        WHERE p.cliente_id = ?
        and estado_corte < 3
        ORDER BY p.id DESC
        LIMIT 6
    `;

    try {
        const [pagos] = await db.query(query, [clienteId]);
        res.json(pagos);
    } catch (error) {
        console.error("Error al obtener historial de pagos:", error);
        res.status(500).json({ error: "Error al cargar el historial" });
    }
});

app.post('/api/registrar-pago', async (req, res) => {
    const { clienteId, montoRecibido, usuarioId } = req.body;
    const connection = db;

    try {
        const [cliente] = await db.query('SELECT costo_mensual, fecha_instalacion, dia_pago FROM clientes WHERE id = ?', [clienteId]);
        if (!cliente.length) return res.status(404).json({ error: "Cliente no encontrado" });
        const clienteData = cliente[0];
        const costoMensual = parseFloat(clienteData.costo_mensual) || 0;
        let saldoRestante = parseFloat(montoRecibido);

        if (!saldoRestante || saldoRestante <= 0) {
            return res.status(400).json({ error: "Monto invalido" });
        }

        const [pagosExistentes] = await db.query(
            'SELECT mes_pagado, monto FROM pagos WHERE cliente_id = ? AND estado_corte < 3',
            [clienteId]
        );

        const historial = {};
        pagosExistentes.forEach(pago => {
            historial[pago.mes_pagado] = (historial[pago.mes_pagado] || 0) + (parseFloat(pago.monto) || 0);
        });

        const bitacora = await consultarBitacoraServicio(db, clienteId);
        const historialPaquetes = await consultarHistorialPaquetes(db, clienteId);
        const estadoCuenta = calcularEstadoCuentaServidor(clienteData, pagosExistentes, bitacora, historialPaquetes);
        const cambiosFechaPago = obtenerCambiosFechaPago(bitacora);
        let ajustePendienteDisponible = parseFloat(estadoCuenta.monto_ajustes_pendientes) || 0;
        const registros = [];
        const aplicarPagoMes = async (etiquetaMes, pendienteMes, ajusteAAplicar = 0, montoEsperadoMes = costoMensual) => {
            const pagadoAntes = historial[etiquetaMes] || 0;
            const montoAAplicar = Math.min(saldoRestante, pendienteMes);
            let nuevoTipo = (montoAAplicar >= pendienteMes && pagadoAntes === 0) ? 'completo' : 'abono';

            if (pagadoAntes + montoAAplicar + ajusteAAplicar >= montoEsperadoMes) nuevoTipo = 'completo';

            const [pagoResult] = await db.query(
                'INSERT INTO pagos (cliente_id, usuario_id, monto, mes_pagado, tipo_pago) VALUES (?, ?, ?, ?, ?)',
                [clienteId, usuarioId, montoAAplicar, etiquetaMes, nuevoTipo]
            );

            const ajusteAplicado = await aplicarAjustesPendientes(db, clienteId, etiquetaMes, ajusteAAplicar, pagoResult.insertId);

            registros.push({
                mes: etiquetaMes,
                monto: montoAAplicar,
                tipo: nuevoTipo,
                ajuste_aplicado: ajusteAplicado
            });
            saldoRestante -= montoAAplicar;
            historial[etiquetaMes] = pagadoAntes + montoAAplicar;
            ajustePendienteDisponible = Number(Math.max(ajustePendienteDisponible - ajusteAplicado, 0).toFixed(2));
        };

        const aplicarPagoCargo = async (cargo) => {
            const pendienteCargo = parseFloat(cargo.pendiente) || 0;
            const montoAAplicar = Math.min(saldoRestante, pendienteCargo);
            if (montoAAplicar <= 0) return;

            const nuevoTipo = montoAAplicar >= pendienteCargo ? 'completo' : 'abono';
            const etiquetaCargo = cargo.mes || obtenerEtiquetaCargoServicio(cargo.tipo_evento);
            const clavePagoCargo = cargo.clave_pago || obtenerClavePagoCargoServicio(cargo.tipo_evento);
            const [pagoResult] = await db.query(
                'INSERT INTO pagos (cliente_id, usuario_id, monto, mes_pagado, tipo_pago) VALUES (?, ?, ?, ?, ?)',
                [clienteId, usuarioId, montoAAplicar, clavePagoCargo, nuevoTipo]
            );

            const cargoAplicado = await aplicarCargosPendientes(db, clienteId, clavePagoCargo, montoAAplicar, pagoResult.insertId);

            registros.push({
                mes: etiquetaCargo,
                mes_registrado: clavePagoCargo,
                monto: montoAAplicar,
                tipo: nuevoTipo,
                cargo_aplicado: cargoAplicado,
                es_cargo: true,
                observaciones: cargo.observaciones || ''
            });
            saldoRestante -= montoAAplicar;
        };

        for (const mesAdeudado of estadoCuenta.meses_adeudados) {
            if (saldoRestante <= 0) break;

            if (mesAdeudado.tipo === 'cargo_servicio') {
                await aplicarPagoCargo(mesAdeudado);
                continue;
            }

            const ajusteAAplicar = Math.min(ajustePendienteDisponible, parseFloat(mesAdeudado.monto_ajuste_pendiente) || 0);

            if ((parseFloat(mesAdeudado.pendiente) || 0) <= 0 && ajusteAAplicar > 0) {
                const ajusteAplicado = await aplicarAjustesPendientes(connection, clienteId, mesAdeudado.mes, ajusteAAplicar);
                registros.push({
                    mes: mesAdeudado.mes,
                    monto: 0,
                    tipo: 'ajuste',
                    ajuste_aplicado: ajusteAplicado
                });
                ajustePendienteDisponible = Number(Math.max(ajustePendienteDisponible - ajusteAplicado, 0).toFixed(2));
                continue;
            }

            await aplicarPagoMes(
                mesAdeudado.mes,
                mesAdeudado.pendiente,
                ajusteAAplicar,
                parseFloat(mesAdeudado.monto_esperado) || costoMensual
            );
        }

        const fechaInstalacion = crearFechaLocalDesdeValor(clienteData.fecha_instalacion) || new Date();
        const ultimoMesVencido = estadoCuenta.meses_vencidos[estadoCuenta.meses_vencidos.length - 1];
        let cursor;

        if (ultimoMesVencido) {
            const [nombreMes, anioTexto] = ultimoMesVencido.split(' ');
            const nombresMeses = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
            cursor = avanzarMesContable(parseInt(anioTexto), nombresMeses.indexOf(nombreMes), 1);
        } else {
            cursor = avanzarMesContable(fechaInstalacion.getFullYear(), fechaInstalacion.getMonth(), 1);
        }

        const anioLimite = new Date().getFullYear() + 2;

        while (saldoRestante > 0 && cursor.anio <= anioLimite) {
            const reglaPagoMes = obtenerReglaPagoParaMes(cursor.anio, cursor.mesIndex, clienteData.dia_pago, cambiosFechaPago);
            if (reglaPagoMes.omitir_mes) {
                cursor = avanzarMesContable(cursor.anio, cursor.mesIndex, 1);
                continue;
            }

            const etiquetaMes = obtenerEtiquetaMes(cursor.anio, cursor.mesIndex);
            const pagadoEnEsteMes = historial[etiquetaMes] || 0;
            const costoMes = obtenerCostoMensualParaMes(historialPaquetes, cursor.anio, cursor.mesIndex, costoMensual);
            const ajusteAAplicar = Math.min(ajustePendienteDisponible, Math.max(costoMes - pagadoEnEsteMes, 0));
            const pendienteMes = Math.max(costoMes - pagadoEnEsteMes - ajusteAAplicar, 0);

            if (pendienteMes <= 0 && ajusteAAplicar > 0) {
                const ajusteAplicado = await aplicarAjustesPendientes(db, clienteId, etiquetaMes, ajusteAAplicar);
                registros.push({
                    mes: etiquetaMes,
                    monto: 0,
                    tipo: 'ajuste',
                    ajuste_aplicado: ajusteAplicado
                });
                ajustePendienteDisponible = Number(Math.max(ajustePendienteDisponible - ajusteAplicado, 0).toFixed(2));
                cursor = avanzarMesContable(cursor.anio, cursor.mesIndex, 1);
                continue;
            }

            if (pendienteMes > 0) {
                await aplicarPagoMes(etiquetaMes, pendienteMes, ajusteAAplicar, costoMes);
            }

            cursor = avanzarMesContable(cursor.anio, cursor.mesIndex, 1);
        }

        res.json({ success: true, detalle: registros });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Error interno procesando el cobro" });
    }
});

/* app.get('/api/estado-cuenta/:id', async (req, res) => {
    try {
        const clienteId = req.params.id;
        const [resultado] = await db.query('SELECT SUM(monto) AS total_pagado FROM pagos WHERE cliente_id = ? AND estado_corte NOT IN (3)',
            [clienteId]
        );
        res.json({ total_pagado: resultado[0].total_pagado || 0 });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}); */

function obtenerEtiquetaMes(anio, mesIndex) {
    const nombresMeses = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
    return `${nombresMeses[mesIndex]} ${anio}`;
}

function obtenerUltimoDiaMes(anio, mesIndex) {
    return new Date(anio, mesIndex + 1, 0).getDate();
}

function avanzarMesContable(anio, mesIndex, cantidad = 1) {
    const totalMeses = (anio * 12) + mesIndex + cantidad;
    return {
        anio: Math.floor(totalMeses / 12),
        mesIndex: totalMeses % 12
    };
}

function compararMesContable(anioA, mesA, anioB, mesB) {
    return (anioA * 12 + mesA) - (anioB * 12 + mesB);
}

function sumarDias(fecha, dias) {
    const resultado = new Date(fecha);
    resultado.setDate(resultado.getDate() + dias);
    return resultado;
}

function obtenerFechaVencimiento(anio, mesIndex, diaPago, diasCompensados = 0) {
    const ultimoDia = obtenerUltimoDiaMes(anio, mesIndex);
    const diaVencimiento = Math.min(diaPago, ultimoDia);
    return sumarDias(new Date(anio, mesIndex, diaVencimiento, 23, 59, 59, 999), diasCompensados);
}

function calcularDiasEntre(fechaInicio, fechaFin = new Date()) {
    const inicio = new Date(fechaInicio);
    const fin = new Date(fechaFin);
    const msPorDia = 1000 * 60 * 60 * 24;
    return Math.max(0, Math.ceil((fin - inicio) / msPorDia));
}

function calcularMontoAjuste(costoMensual, diasCompensados) {
    const costo = parseFloat(costoMensual) || 0;
    const dias = parseInt(diasCompensados) || 0;
    return Math.floor((costo / 30) * dias);
}

function normalizarDiaPago(dia) {
    const valor = parseInt(dia, 10);
    if (!valor || valor < 1 || valor > 31) return null;
    return valor;
}

function crearFechaLocalDesdeValor(valor) {
    if (!valor) return null;

    if (valor instanceof Date) {
        if (Number.isNaN(valor.getTime())) return null;
        return new Date(valor.getUTCFullYear(), valor.getUTCMonth(), valor.getUTCDate());
    }

    const texto = String(valor).trim();
    const partesFecha = texto.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (partesFecha) {
        return new Date(
            parseInt(partesFecha[1], 10),
            parseInt(partesFecha[2], 10) - 1,
            parseInt(partesFecha[3], 10)
        );
    }

    const fecha = new Date(texto);
    if (Number.isNaN(fecha.getTime())) return null;
    return new Date(fecha.getFullYear(), fecha.getMonth(), fecha.getDate());
}

function formatearFechaSql(fecha) {
    if (!(fecha instanceof Date) || Number.isNaN(fecha.getTime())) return null;
    const anio = fecha.getFullYear();
    const mes = String(fecha.getMonth() + 1).padStart(2, '0');
    const dia = String(fecha.getDate()).padStart(2, '0');
    return `${anio}-${mes}-${dia}`;
}

function restarDiasFecha(fecha, dias) {
    const resultado = new Date(fecha);
    resultado.setDate(resultado.getDate() - dias);
    return resultado;
}

function sumarMesesCompletosFecha(fecha, meses) {
    const resultado = new Date(fecha.getFullYear(), fecha.getMonth() + meses, 1);
    const ultimoDiaDestino = obtenerUltimoDiaMes(resultado.getFullYear(), resultado.getMonth());
    resultado.setDate(Math.min(fecha.getDate(), ultimoDiaDestino));
    return resultado;
}

function obtenerRestriccionCambioPaquete(historialPaquetes = [], fechaReferencia = new Date()) {
    const historialOrdenado = [...(historialPaquetes || [])]
        .filter(periodo => crearFechaLocalDesdeValor(periodo.fecha_inicio))
        .sort((a, b) => {
            const fechaA = crearFechaLocalDesdeValor(a.fecha_inicio);
            const fechaB = crearFechaLocalDesdeValor(b.fecha_inicio);
            const diferencia = fechaA - fechaB;
            if (diferencia !== 0) return diferencia;
            return (parseInt(a.id, 10) || 0) - (parseInt(b.id, 10) || 0);
        });

    if (historialOrdenado.length <= 1) {
        return { bloqueado: false };
    }

    const ultimoCambio = historialOrdenado[historialOrdenado.length - 1];
    const fechaUltimoCambio = crearFechaLocalDesdeValor(ultimoCambio.fecha_inicio);
    if (!fechaUltimoCambio) {
        return { bloqueado: false };
    }

    const fecha60Dias = sumarDias(fechaUltimoCambio, 60);
    const fecha2Meses = sumarMesesCompletosFecha(fechaUltimoCambio, 2);
    const fechaPermitida = fecha60Dias <= fecha2Meses ? fecha60Dias : fecha2Meses;
    const referencia = fechaReferencia instanceof Date
        ? new Date(fechaReferencia.getFullYear(), fechaReferencia.getMonth(), fechaReferencia.getDate())
        : crearFechaLocalDesdeValor(fechaReferencia);
    const msPorDia = 1000 * 60 * 60 * 24;
    const diasRestantes = referencia && referencia < fechaPermitida
        ? Math.ceil((fechaPermitida - referencia) / msPorDia)
        : 0;

    return {
        bloqueado: diasRestantes > 0,
        fecha_ultimo_cambio: formatearFechaSql(fechaUltimoCambio),
        fecha_proximo_cambio: formatearFechaSql(fechaPermitida),
        dias_restantes: diasRestantes
    };
}

async function consultarHistorialPaquetes(ejecutor, clienteId) {
    const [rows] = await ejecutor.query(
        `SELECT h.id, h.cliente_id, h.paquete_id, h.costo_mensual, h.fecha_inicio, h.fecha_fin,
                h.usuario_id, h.fecha_registro,
                p.nombre_paquete, p.velocidad_mbps, p.velocidad_garantizada_mbps, p.costo AS paquete_costo
         FROM cliente_paquetes_historial h
         JOIN paquetes p ON p.id = h.paquete_id
         WHERE h.cliente_id = ?
         ORDER BY h.fecha_inicio ASC, h.id ASC`,
        [clienteId]
    );

    return rows;
}

function obtenerCostoMensualParaMes(historialPaquetes = [], anio, mesIndex, costoDefault = 0) {
    const costoRespaldo = parseFloat(costoDefault) || 0;
    const mesReferencia = new Date(anio, mesIndex, 1);
    let periodoSeleccionado = null;

    for (const periodo of historialPaquetes || []) {
        const fechaInicio = crearFechaLocalDesdeValor(periodo.fecha_inicio);
        const fechaFin = crearFechaLocalDesdeValor(periodo.fecha_fin);

        if (!fechaInicio) continue;
        if (fechaInicio <= mesReferencia && (!fechaFin || fechaFin >= mesReferencia)) {
            periodoSeleccionado = periodo;
        }
    }

    const costoHistorial = parseFloat(periodoSeleccionado?.costo_mensual);
    return Number.isFinite(costoHistorial) && costoHistorial > 0
        ? costoHistorial
        : costoRespaldo;
}

function crearFechaHoraDesdeValor(valor) {
    if (!valor) return null;
    if (valor instanceof Date) {
        return Number.isNaN(valor.getTime()) ? null : new Date(valor.getTime());
    }

    const texto = String(valor).trim();
    const fecha = new Date(texto.includes(' ') ? texto.replace(' ', 'T') : texto);
    return Number.isNaN(fecha.getTime()) ? null : fecha;
}

function obtenerDiaPagoDesdeFechaInstalacion(fechaInstalacion) {
    const fecha = crearFechaLocalDesdeValor(fechaInstalacion);
    if (!fecha) return null;
    return fecha.getDate();
}

function obtenerEtiquetaCargoServicio(tipoEvento) {
    if (tipoEvento === 'cambio_fecha_pago') return 'Cargo cambio fecha de pago';
    if (tipoEvento === 'cambio_paquete') return 'Cargo cambio de paquete';
    return 'Cargo de servicio';
}

function obtenerClavePagoCargoServicio(tipoEvento) {
    if (tipoEvento === 'cambio_fecha_pago') return 'Cargo prorrateo';
    if (tipoEvento === 'cambio_paquete') return 'Cargo paquete';
    return 'Cargo servicio';
}

function calcularDiasProrrateoCambioPago(diaActual, diaNuevo) {
    const actual = Math.min(Math.max(parseInt(diaActual) || 1, 1), 30);
    const nuevo = Math.min(Math.max(parseInt(diaNuevo) || 1, 1), 30);
    if (actual === nuevo) return 0;
    return nuevo > actual ? nuevo - actual : (30 - actual) + nuevo;
}

function calcularDiasRestantesHastaCorte(fechaCambio, diaPago) {
    const fecha = fechaCambio instanceof Date ? fechaCambio : crearFechaLocalDesdeValor(fechaCambio);
    if (!fecha) return 0;
    return calcularDiasProrrateoCambioPago(fecha.getDate(), diaPago);
}

function calcularProrrateoCambioPaquete(costoAnterior, costoNuevo, diasRestantes) {
    const anterior = parseFloat(costoAnterior) || 0;
    const nuevo = parseFloat(costoNuevo) || 0;
    const dias = parseInt(diasRestantes, 10) || 0;
    const diferenciaMensual = Number((nuevo - anterior).toFixed(2));
    const montoProrrateo = Math.floor((Math.abs(diferenciaMensual) / 30) * dias);
    let tipoProrrateo = 'sin_ajuste';
    let montoAjuste = 0;

    if (montoProrrateo > 0 && diferenciaMensual > 0) {
        tipoProrrateo = 'cargo';
        montoAjuste = -montoProrrateo;
    } else if (montoProrrateo > 0 && diferenciaMensual < 0) {
        tipoProrrateo = 'saldo_favor';
        montoAjuste = montoProrrateo;
    }

    return {
        diferencia_mensual: diferenciaMensual,
        dias_restantes: dias,
        monto_prorrateo: Number(montoProrrateo.toFixed(2)),
        monto_ajuste: Number(montoAjuste.toFixed(2)),
        tipo_prorrateo: tipoProrrateo
    };
}

function extraerDiaCambioFechaPago(observaciones, etiqueta) {
    const texto = String(observaciones || '');
    const coincidencia = texto.match(new RegExp(`${etiqueta}:\\s*(\\d{1,2})`, 'i'));
    return coincidencia ? normalizarDiaPago(coincidencia[1]) : null;
}

function obtenerSiguienteVencimientoDesde(fechaBase, diaPago) {
    const vencimientoActual = obtenerFechaVencimiento(fechaBase.getFullYear(), fechaBase.getMonth(), diaPago, 0);
    if (vencimientoActual >= fechaBase) {
        return {
            anio: fechaBase.getFullYear(),
            mesIndex: fechaBase.getMonth(),
            fecha: vencimientoActual
        };
    }

    const siguiente = avanzarMesContable(fechaBase.getFullYear(), fechaBase.getMonth(), 1);
    return {
        ...siguiente,
        fecha: obtenerFechaVencimiento(siguiente.anio, siguiente.mesIndex, diaPago, 0)
    };
}

function obtenerCambiosFechaPago(bitacora = []) {
    return (bitacora || [])
        .filter(evento => evento.tipo_evento === 'cambio_fecha_pago' && evento.estado === 'Finalizado')
        .map(evento => {
            const diaAnterior = extraerDiaCambioFechaPago(evento.observaciones, 'Dia anterior');
            const nuevoDia = extraerDiaCambioFechaPago(evento.observaciones, 'Nuevo dia');
            const fechaCambio = crearFechaHoraDesdeValor(evento.fecha_inicio || evento.fecha_fin);

            if (!diaAnterior || !nuevoDia || !fechaCambio) return null;

            const vencimientoAnterior = obtenerFechaVencimiento(
                fechaCambio.getFullYear(),
                fechaCambio.getMonth(),
                diaAnterior,
                0
            );
            const fechaBase = fechaCambio <= vencimientoAnterior ? vencimientoAnterior : fechaCambio;
            const inicioNuevoDia = obtenerSiguienteVencimientoDesde(fechaBase, nuevoDia);
            const omitirMesCambio = fechaCambio <= vencimientoAnterior
                && compararMesContable(
                    inicioNuevoDia.anio,
                    inicioNuevoDia.mesIndex,
                    fechaCambio.getFullYear(),
                    fechaCambio.getMonth()
                ) > 0;

            return {
                id: evento.id,
                fecha_cambio: fechaCambio,
                dia_anterior: diaAnterior,
                nuevo_dia: nuevoDia,
                mes_cambio: {
                    anio: fechaCambio.getFullYear(),
                    mesIndex: fechaCambio.getMonth()
                },
                inicio_nuevo_dia: inicioNuevoDia,
                omitir_mes_cambio: omitirMesCambio
            };
        })
        .filter(Boolean)
        .sort((a, b) => {
            const diferenciaFecha = a.fecha_cambio - b.fecha_cambio;
            if (diferenciaFecha !== 0) return diferenciaFecha;
            return (a.id || 0) - (b.id || 0);
        });
}

function obtenerReglaPagoParaMes(anio, mesIndex, diaPagoActual, cambiosFechaPago = []) {
    let diaPago = cambiosFechaPago.length
        ? cambiosFechaPago[0].dia_anterior
        : normalizarDiaPago(diaPagoActual);
    let omitirMes = false;

    for (const cambio of cambiosFechaPago) {
        const comparacionConCambio = compararMesContable(anio, mesIndex, cambio.mes_cambio.anio, cambio.mes_cambio.mesIndex);
        if (comparacionConCambio < 0) break;

        const comparacionConInicio = compararMesContable(anio, mesIndex, cambio.inicio_nuevo_dia.anio, cambio.inicio_nuevo_dia.mesIndex);
        if (comparacionConInicio < 0) {
            if (comparacionConCambio === 0 && cambio.omitir_mes_cambio) {
                omitirMes = true;
            }
            continue;
        }

        diaPago = cambio.nuevo_dia;
        omitirMes = false;
    }

    return {
        dia_pago: normalizarDiaPago(diaPago) || normalizarDiaPago(diaPagoActual) || 1,
        omitir_mes: omitirMes
    };
}
let columnaObservacionesBitacora = null;
let columnaObservacionesBitacoraCargada = false;

async function obtenerColumnaObservacionesBitacora(ejecutor) {
    if (columnaObservacionesBitacoraCargada) {
        return columnaObservacionesBitacora;
    }

    const [columnas] = await ejecutor.query('SHOW COLUMNS FROM bitacora_servicio');
    const columnaEncontrada = columnas.find(columna => {
        const nombre = String(columna.Field || '').toLowerCase().trim();
        return nombre === 'observaciones' || nombre === 'observacion';
    });
    columnaObservacionesBitacora = columnaEncontrada ? columnaEncontrada.Field : null;
    columnaObservacionesBitacoraCargada = true;

    return columnaObservacionesBitacora;
}

function escaparIdentificadorMysql(nombre) {
    return `\`${String(nombre).replace(/`/g, '``')}\``;
}

async function consultarBitacoraServicio(ejecutor, clienteId) {
    const columnaObservaciones = await obtenerColumnaObservacionesBitacora(ejecutor);
    const selectObservaciones = columnaObservaciones
        ? `b.${escaparIdentificadorMysql(columnaObservaciones)} AS observaciones,`
        : 'NULL AS observaciones,';

    const [bitacora] = await ejecutor.query(
        `SELECT b.*, ${selectObservaciones}
            COALESCE((
                SELECT SUM(a.monto_aplicado)
                FROM aplicaciones_ajustes_servicio a
                WHERE a.bitacora_id = b.id
            ), 0) AS monto_ajuste_aplicado,
            (
                SELECT GROUP_CONCAT(CONCAT(a.mes_aplicado, '::', a.monto_aplicado) SEPARATOR '||')
                FROM aplicaciones_ajustes_servicio a
                WHERE a.bitacora_id = b.id
            ) AS aplicaciones_ajuste
         FROM bitacora_servicio b
         WHERE b.cliente_id = ?
         ORDER BY b.id DESC`,
        [clienteId]
    );

    return bitacora;
}

async function finalizarAusenciasProgramadasVencidas(ejecutor, clienteId = null) {
    const params = [];
    let filtroCliente = '';

    if (clienteId) {
        filtroCliente = 'AND b.cliente_id = ?';
        params.push(clienteId);
    }

    const [eventos] = await ejecutor.query(
        `SELECT b.*, c.costo_mensual
         FROM bitacora_servicio b
         JOIN clientes c ON c.id = b.cliente_id
         WHERE b.tipo_evento = 'decision_usuario'
           AND b.estado = 'Activo'
           AND b.fecha_fin IS NOT NULL
           AND b.fecha_fin <= NOW()
           ${filtroCliente}`,
        params
    );

    for (const evento of eventos) {
        const dias = parseInt(evento.dias_compensados) || calcularDiasEntre(evento.fecha_inicio, evento.fecha_fin);
        const montoAjuste = parseFloat(evento.monto_ajuste) || calcularMontoAjuste(evento.costo_mensual, dias);

        await ejecutor.query(
            `UPDATE bitacora_servicio
             SET dias_compensados = ?, monto_ajuste = ?, estado = 'Finalizado'
             WHERE id = ?`,
            [dias, montoAjuste, evento.id]
        );

        await ejecutor.query(
            `UPDATE clientes
             SET estado_servicio = 'activo'
             WHERE id = ?
               AND NOT EXISTS (
                   SELECT 1
                   FROM bitacora_servicio
                   WHERE cliente_id = ?
                     AND estado = 'Activo'
                     AND id <> ?
               )`,
            [evento.cliente_id, evento.cliente_id, evento.id]
        );
    }
}

function obtenerAplicacionesAjuste(evento) {
    if (!evento.aplicaciones_ajuste) return [];

    return String(evento.aplicaciones_ajuste)
        .split('||')
        .map(item => {
            const [mes, monto] = item.split('::');
            return { mes, monto: parseFloat(monto) || 0 };
        })
        .filter(item => item.mes && item.monto > 0);
}

function eventoGeneraSaldoFavor(evento) {
    return ['falla_tecnica', 'decision_usuario', 'cambio_paquete'].includes(evento.tipo_evento)
        && evento.estado === 'Finalizado'
        && (parseFloat(evento.monto_ajuste) || 0) > 0;
}

function eventoGeneraCargoServicio(evento) {
    return ['cambio_fecha_pago', 'cambio_paquete'].includes(evento.tipo_evento)
        && evento.estado === 'Finalizado'
        && (parseFloat(evento.monto_ajuste) || 0) < 0;
}

function resumirAjustesServicio(eventos) {
    const aplicadoPorMes = {};
    let totalGenerado = 0;
    let totalAplicado = 0;

    (eventos || []).forEach(evento => {
        if (!eventoGeneraSaldoFavor(evento)) return;

        const montoGenerado = parseFloat(evento.monto_ajuste) || 0;
        const aplicaciones = obtenerAplicacionesAjuste(evento);
        const montoAplicado = aplicaciones.reduce((total, item) => total + item.monto, 0);

        totalGenerado += montoGenerado;
        totalAplicado += montoAplicado;

        aplicaciones.forEach(item => {
            aplicadoPorMes[item.mes] = (aplicadoPorMes[item.mes] || 0) + item.monto;
        });
    });

    return {
        total_generado: Number(totalGenerado.toFixed(2)),
        total_aplicado: Number(totalAplicado.toFixed(2)),
        pendiente: Number(Math.max(totalGenerado - totalAplicado, 0).toFixed(2)),
        aplicado_por_mes: aplicadoPorMes
    };
}

function resumirCargosServicio(eventos) {
    const cargos = [];
    let totalGenerado = 0;
    let totalAplicado = 0;

    (eventos || []).forEach(evento => {
        if (!eventoGeneraCargoServicio(evento)) return;

        const montoGenerado = Math.abs(parseFloat(evento.monto_ajuste) || 0);
        const aplicaciones = obtenerAplicacionesAjuste(evento);
        const montoAplicado = aplicaciones.reduce((total, item) => total + item.monto, 0);
        const pendiente = Number(Math.max(montoGenerado - montoAplicado, 0).toFixed(2));

        totalGenerado += montoGenerado;
        totalAplicado += montoAplicado;

        if (pendiente > 0) {
            cargos.push({
                bitacora_id: evento.id,
                tipo_evento: evento.tipo_evento,
                concepto: obtenerEtiquetaCargoServicio(evento.tipo_evento),
                clave_pago: obtenerClavePagoCargoServicio(evento.tipo_evento),
                monto_generado: Number(montoGenerado.toFixed(2)),
                monto_aplicado: Number(montoAplicado.toFixed(2)),
                pendiente,
                observaciones: evento.observaciones || ''
            });
        }
    });

    return {
        total_generado: Number(totalGenerado.toFixed(2)),
        total_aplicado: Number(totalAplicado.toFixed(2)),
        pendiente: Number(Math.max(totalGenerado - totalAplicado, 0).toFixed(2)),
        pendientes: cargos
    };
}

async function aplicarAjustesPendientes(ejecutor, clienteId, mesAplicado, montoAAplicar, pagoId = null) {
    let restante = Number((parseFloat(montoAAplicar) || 0).toFixed(2));
    if (restante <= 0) return 0;

    const [eventos] = await ejecutor.query(
        `SELECT b.id, b.monto_ajuste,
            COALESCE(SUM(a.monto_aplicado), 0) AS monto_aplicado
         FROM bitacora_servicio b
         LEFT JOIN aplicaciones_ajustes_servicio a ON a.bitacora_id = b.id
         WHERE b.cliente_id = ?
           AND b.tipo_evento IN ('falla_tecnica', 'decision_usuario', 'cambio_paquete')
           AND b.estado = 'Finalizado'
           AND b.monto_ajuste > 0
         GROUP BY b.id, b.monto_ajuste, b.fecha_fin, b.fecha_inicio
         HAVING (b.monto_ajuste - monto_aplicado) > 0
         ORDER BY COALESCE(b.fecha_fin, b.fecha_inicio), b.id`,
        [clienteId]
    );

    let aplicado = 0;

    for (const evento of eventos) {
        if (restante <= 0) break;

        const pendienteEvento = Math.max((parseFloat(evento.monto_ajuste) || 0) - (parseFloat(evento.monto_aplicado) || 0), 0);
        const montoAplicado = Number(Math.min(restante, pendienteEvento).toFixed(2));

        if (montoAplicado <= 0) continue;

        await ejecutor.query(
            `INSERT INTO aplicaciones_ajustes_servicio
                (bitacora_id, cliente_id, pago_id, mes_aplicado, monto_aplicado)
             VALUES (?, ?, ?, ?, ?)`,
            [evento.id, clienteId, pagoId, mesAplicado, montoAplicado]
        );

        restante = Number((restante - montoAplicado).toFixed(2));
        aplicado = Number((aplicado + montoAplicado).toFixed(2));
    }

    return aplicado;
}

async function aplicarCargosPendientes(ejecutor, clienteId, mesAplicado, montoAAplicar, pagoId = null) {
    let restante = Number((parseFloat(montoAAplicar) || 0).toFixed(2));
    if (restante <= 0) return 0;

    const [eventos] = await ejecutor.query(
        `SELECT b.id, b.tipo_evento, ABS(b.monto_ajuste) AS monto_cargo,
            COALESCE(SUM(a.monto_aplicado), 0) AS monto_aplicado
         FROM bitacora_servicio b
         LEFT JOIN aplicaciones_ajustes_servicio a ON a.bitacora_id = b.id
         WHERE b.cliente_id = ?
           AND b.tipo_evento IN ('cambio_fecha_pago', 'cambio_paquete')
           AND b.estado = 'Finalizado'
           AND b.monto_ajuste < 0
         GROUP BY b.id, b.tipo_evento, b.monto_ajuste, b.fecha_fin, b.fecha_inicio
         HAVING (monto_cargo - monto_aplicado) > 0
         ORDER BY COALESCE(b.fecha_fin, b.fecha_inicio), b.id`,
        [clienteId]
    );

    let aplicado = 0;

    for (const evento of eventos) {
        if (restante <= 0) break;

        const pendienteEvento = Math.max((parseFloat(evento.monto_cargo) || 0) - (parseFloat(evento.monto_aplicado) || 0), 0);
        const montoAplicado = Number(Math.min(restante, pendienteEvento).toFixed(2));

        if (montoAplicado <= 0) continue;

        await ejecutor.query(
            `INSERT INTO aplicaciones_ajustes_servicio
                (bitacora_id, cliente_id, pago_id, mes_aplicado, monto_aplicado)
             VALUES (?, ?, ?, ?, ?)`,
            [evento.id, clienteId, pagoId, mesAplicado, montoAplicado]
        );

        restante = Number((restante - montoAplicado).toFixed(2));
        aplicado = Number((aplicado + montoAplicado).toFixed(2));
    }

    return aplicado;
}

function resumirBitacoraServicio(bitacora) {
    const eventos = bitacora || [];
    const suspensionActiva = eventos.find(evento => evento.estado === 'Activo') || null;
    const diasCompensadosFinalizados = eventos.reduce((total, evento) => {
        return evento.estado === 'Finalizado' ? total + (parseInt(evento.dias_compensados) || 0) : total;
    }, 0);
    const diasCongeladosActivos = suspensionActiva && suspensionActiva.tipo_evento === 'decision_usuario'
        ? calcularDiasEntre(suspensionActiva.fecha_inicio)
        : 0;
    const ajustes = resumirAjustesServicio(eventos);
    const cargos = resumirCargosServicio(eventos);

    return {
        eventos,
        suspension_activa: suspensionActiva,
        dias_compensados: diasCompensadosFinalizados + diasCongeladosActivos,
        dias_congelados_activos: diasCongeladosActivos,
        dias_compensados_efectivos: 0,
        monto_ajustes: ajustes.pendiente,
        ajustes,
        cargos
    };
}

function mesEstaVencido(anio, mesIndex, diaPago, hoy = new Date(), diasCompensados = 0) {
    const comparacionMes = compararMesContable(anio, mesIndex, hoy.getFullYear(), hoy.getMonth());

    if (comparacionMes < 0) return true;
    if (comparacionMes > 0) return false;

    return hoy >= obtenerFechaVencimiento(anio, mesIndex, diaPago, diasCompensados);
}

function calcularEstadoCuentaServidor(cliente, pagos, bitacora = [], historialPaquetes = []) {
    const costoMensualActual = parseFloat(cliente.costo_mensual) || 0;
    const fechaInstalacion = crearFechaLocalDesdeValor(cliente.fecha_instalacion) || new Date();
    const diaPago = normalizarDiaPago(cliente.dia_pago) || obtenerDiaPagoDesdeFechaInstalacion(cliente.fecha_instalacion) || 1;
    const totalPagado = pagos.reduce((total, pago) => total + (parseFloat(pago.monto) || 0), 0);
    const resumenServicio = resumirBitacoraServicio(bitacora);
    const ajustesServicio = resumenServicio.ajustes;
    const cargosServicio = resumenServicio.cargos;
    let saldoAjustePendiente = ajustesServicio.pendiente;
    const pagosPorMes = {};

    pagos.forEach(pago => {
        const mes = pago.mes_pagado;
        pagosPorMes[mes] = (pagosPorMes[mes] || 0) + (parseFloat(pago.monto) || 0);
    });

    const mesesAdeudados = [];
    const mesesVencidos = [];
    let totalMensualTeorico = 0;
    let fechaProximoPago = null;
    let cursor = avanzarMesContable(fechaInstalacion.getFullYear(), fechaInstalacion.getMonth(), 1);
    const hoy = new Date();
    const cambiosFechaPago = obtenerCambiosFechaPago(bitacora);

    while (compararMesContable(cursor.anio, cursor.mesIndex, hoy.getFullYear(), hoy.getMonth()) <= 0) {
        const reglaPagoMes = obtenerReglaPagoParaMes(cursor.anio, cursor.mesIndex, diaPago, cambiosFechaPago);

        if (!reglaPagoMes.omitir_mes && mesEstaVencido(cursor.anio, cursor.mesIndex, reglaPagoMes.dia_pago, hoy, 0)) {
            const etiquetaMes = obtenerEtiquetaMes(cursor.anio, cursor.mesIndex);
            const costoMensualMes = obtenerCostoMensualParaMes(historialPaquetes, cursor.anio, cursor.mesIndex, costoMensualActual);
            const pagadoEnMes = pagosPorMes[etiquetaMes] || 0;
            const ajusteAplicadoEnMes = ajustesServicio.aplicado_por_mes[etiquetaMes] || 0;
            const pendienteSinAjuste = Math.max(costoMensualMes - pagadoEnMes - ajusteAplicadoEnMes, 0);
            const ajustePendienteAplicable = Number(Math.min(saldoAjustePendiente, pendienteSinAjuste).toFixed(2));
            const pendiente = Number(Math.max(pendienteSinAjuste - ajustePendienteAplicable, 0).toFixed(2));

            mesesVencidos.push(etiquetaMes);
            totalMensualTeorico = Number((totalMensualTeorico + costoMensualMes).toFixed(2));
            saldoAjustePendiente = Number(Math.max(saldoAjustePendiente - ajustePendienteAplicable, 0).toFixed(2));

            if (pendienteSinAjuste > 0) {
                mesesAdeudados.push({
                    mes: etiquetaMes,
                    monto_esperado: costoMensualMes,
                    monto_cubierto: Math.min(pagadoEnMes + ajusteAplicadoEnMes, costoMensualMes),
                    monto_ajuste_aplicado: ajusteAplicadoEnMes,
                    monto_ajuste_pendiente: ajustePendienteAplicable,
                    pendiente_sin_ajuste: Number(pendienteSinAjuste.toFixed(2)),
                    pendiente: pendiente
                });
            }
        } else if (!reglaPagoMes.omitir_mes && !fechaProximoPago) {
            fechaProximoPago = obtenerFechaVencimiento(cursor.anio, cursor.mesIndex, reglaPagoMes.dia_pago, 0);
        }

        cursor = avanzarMesContable(cursor.anio, cursor.mesIndex, 1);
    }

    if (!fechaProximoPago) {
        const reglaPagoMes = obtenerReglaPagoParaMes(cursor.anio, cursor.mesIndex, diaPago, cambiosFechaPago);
        fechaProximoPago = obtenerFechaVencimiento(cursor.anio, cursor.mesIndex, reglaPagoMes.dia_pago, 0);
    }

    cargosServicio.pendientes.forEach(cargo => {
        mesesAdeudados.push({
            tipo: 'cargo_servicio',
            tipo_evento: cargo.tipo_evento,
            mes: cargo.concepto,
            clave_pago: cargo.clave_pago,
            monto_esperado: cargo.monto_generado,
            monto_cubierto: cargo.monto_aplicado,
            monto_cargo_pendiente: cargo.pendiente,
            pendiente_sin_ajuste: cargo.pendiente,
            pendiente: cargo.pendiente,
            observaciones: cargo.observaciones
        });
    });

    const mesesTranscurridos = mesesVencidos.length;
    const montoAjustes = resumenServicio.monto_ajustes;
    const totalTeorico = Math.max(totalMensualTeorico - ajustesServicio.total_aplicado + cargosServicio.total_generado, 0);
    const adeudoMensual = mesesAdeudados
        .filter(mes => mes.tipo !== 'cargo_servicio')
        .reduce((total, mes) => total + mes.pendiente, 0);
    const adeudoCargos = cargosServicio.pendiente;
    const adeudoActual = Number((adeudoMensual + adeudoCargos).toFixed(2));
    const saldoFavor = Number((Math.max(totalPagado - totalTeorico, 0) + saldoAjustePendiente).toFixed(2));
    const mesesAdeudoDecimal = costoMensualActual > 0 ? adeudoActual / costoMensualActual : 0;

    return {
        total_pagado_historico: totalPagado,
        total_teorico: totalTeorico,
        adeudo_actual: adeudoActual,
        saldo_favor: saldoFavor,
        meses_transcurridos: mesesTranscurridos,
        meses_adeudo_decimal: Number(mesesAdeudoDecimal.toFixed(2)),
        meses_vencidos: mesesVencidos,
        meses_adeudados: mesesAdeudados,
        adeudo_mensual: adeudoMensual,
        monto_ajustes: montoAjustes,
        monto_ajustes_generados: ajustesServicio.total_generado,
        monto_ajustes_aplicados: ajustesServicio.total_aplicado,
        monto_ajustes_pendientes: ajustesServicio.pendiente,
        monto_cargos_generados: cargosServicio.total_generado,
        monto_cargos_aplicados: cargosServicio.total_aplicado,
        monto_cargos_pendientes: cargosServicio.pendiente,
        cargos_pendientes: cargosServicio.pendientes,
        adeudo_cargos: adeudoCargos,
        dias_compensados: resumenServicio.dias_compensados,
        dias_congelados_activos: resumenServicio.dias_congelados_activos,
        dias_compensados_efectivos: 0,
        fecha_proximo_pago: fechaProximoPago,
        servicio: resumenServicio
    };
}

app.get('/api/clientes/:id/estado-cuenta-completo', async (req, res) => {
    const clienteId = req.params.id;

    try {
        await finalizarAusenciasProgramadasVencidas(db, clienteId);

        const [clienteRows] = await db.query(
            `SELECT c.*, l.nombre AS localidad_nombre, l.codigo_localidad,
                    paq.nombre_paquete AS paquete_nombre,
                    paq.velocidad_mbps AS paquete_velocidad_mbps,
                    paq.velocidad_garantizada_mbps AS paquete_velocidad_garantizada_mbps,
                    paq.costo AS paquete_costo,
                    COALESCE(paq.nombre_paquete, c.paquete) AS paquete_display
             FROM clientes c
             LEFT JOIN localidades l ON c.localidad_id = l.id
             LEFT JOIN paquetes paq ON paq.id = c.paquete_id
             WHERE c.id = ?`,
            [clienteId]
        );

        if (clienteRows.length === 0) {
            return res.status(404).json({ error: 'Cliente no encontrado' });
        }

        const columnaObservaciones = await obtenerColumnaObservacionesBitacora(db);
        const selectObservacionesAjuste = columnaObservaciones
            ? `GROUP_CONCAT(NULLIF(TRIM(b.${escaparIdentificadorMysql(columnaObservaciones)}), '') ORDER BY b.fecha_inicio, b.id SEPARATOR ' | ') AS observaciones_ajuste`
            : 'NULL AS observaciones_ajuste';

        const [pagos] = await db.query(
            `SELECT p.*, u.nombre AS cobrador_nombre,
                    COALESCE(aj.monto_ajuste_aplicado, 0) AS monto_ajuste_aplicado,
                    COALESCE(aj.monto_cargo_aplicado, 0) AS monto_cargo_aplicado,
                    aj.tipos_ajuste,
                    aj.dias_compensados_ajuste,
                    aj.observaciones_ajuste
             FROM pagos p
             LEFT JOIN usuarios u ON p.usuario_id = u.id
             LEFT JOIN (
                SELECT a.pago_id,
                       SUM(CASE WHEN b.monto_ajuste > 0 THEN a.monto_aplicado ELSE 0 END) AS monto_ajuste_aplicado,
                       SUM(CASE WHEN b.monto_ajuste < 0 THEN a.monto_aplicado ELSE 0 END) AS monto_cargo_aplicado,
                       GROUP_CONCAT(b.tipo_evento ORDER BY b.fecha_inicio, b.id SEPARATOR ',') AS tipos_ajuste,
                       GROUP_CONCAT(b.dias_compensados ORDER BY b.fecha_inicio, b.id SEPARATOR ',') AS dias_compensados_ajuste,
                       ${selectObservacionesAjuste}
                FROM aplicaciones_ajustes_servicio a
                JOIN bitacora_servicio b ON b.id = a.bitacora_id
                WHERE a.cliente_id = ? AND a.pago_id IS NOT NULL
                GROUP BY a.pago_id
             ) aj ON aj.pago_id = p.id
             WHERE p.cliente_id = ? AND p.estado_corte < 3
             ORDER BY p.id DESC`,
            [clienteId, clienteId]
        );

        const bitacora = await consultarBitacoraServicio(db, clienteId);
        const historialPaquetes = await consultarHistorialPaquetes(db, clienteId);

        const estadoCuenta = calcularEstadoCuentaServidor(clienteRows[0], pagos, bitacora, historialPaquetes);

        res.json({
            cliente: clienteRows[0],
            historial_pagos: pagos,
            historial_paquetes: historialPaquetes,
            bitacora_servicio: bitacora,
            estado_cuenta: estadoCuenta
        });
    } catch (error) {
        console.error('Error al calcular estado de cuenta completo:', error);
        res.status(500).json({ error: 'Error al calcular estado de cuenta del cliente' });
    }
});

app.post('/api/clientes/:id/cambiar-paquete', async (req, res) => {
    const clienteId = req.params.id;
    const { paquete_id, costo_mensual, fecha_inicio, usuario_id, rol_usuario } = req.body;
    const connection = await db.getConnection();

    try {
        const hoy = new Date();
        const hoyLocal = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate());
        if (parseInt(rol_usuario, 10) !== 2) {
            return res.status(403).json({
                success: false,
                error: 'Acceso denegado: solo el administrador puede cambiar paquetes.'
            });
        }

        const paqueteSeleccionado = await obtenerPaqueteActivoPorId(paquete_id, connection);
        if (!paqueteSeleccionado) {
            return res.status(400).json({ success: false, error: 'Selecciona un paquete valido.' });
        }

        const costoMensual = costo_mensual === undefined || costo_mensual === null || costo_mensual === ''
            ? parseFloat(paqueteSeleccionado.costo)
            : parseFloat(costo_mensual);

        if (!Number.isFinite(costoMensual) || costoMensual <= 0) {
            return res.status(400).json({ success: false, error: 'El costo mensual no es valido.' });
        }

        const fechaInicio = crearFechaLocalDesdeValor(fecha_inicio) || hoyLocal;
        if (!fechaInicio) {
            return res.status(400).json({ success: false, error: 'La fecha de inicio no es valida.' });
        }

        if (formatearFechaSql(fechaInicio) !== formatearFechaSql(hoyLocal)) {
            return res.status(400).json({ success: false, error: 'El cambio de paquete se aplica desde hoy.' });
        }

        await connection.beginTransaction();

        const [clienteRows] = await connection.query(
            `SELECT id, paquete_id, paquete, costo_mensual, fecha_instalacion, dia_pago
             FROM clientes
             WHERE id = ?
             FOR UPDATE`,
            [clienteId]
        );

        if (clienteRows.length === 0) {
            await connection.rollback();
            return res.status(404).json({ success: false, error: 'Cliente no encontrado.' });
        }

        const cliente = clienteRows[0];
        const fechaInstalacion = crearFechaLocalDesdeValor(cliente.fecha_instalacion);
        if (fechaInstalacion && fechaInicio < fechaInstalacion) {
            await connection.rollback();
            return res.status(400).json({
                success: false,
                error: 'La fecha de inicio no puede ser anterior a la instalacion.'
            });
        }

        const [pagos] = await connection.query(
            'SELECT mes_pagado, monto FROM pagos WHERE cliente_id = ? AND estado_corte < 3',
            [clienteId]
        );
        const bitacora = await consultarBitacoraServicio(connection, clienteId);
        const historialPaquetesCuenta = await consultarHistorialPaquetes(connection, clienteId);
        const estadoCuenta = calcularEstadoCuentaServidor(cliente, pagos, bitacora, historialPaquetesCuenta);
        const adeudoActual = parseFloat(estadoCuenta.adeudo_actual) || 0;
        if (adeudoActual > 0) {
            await connection.rollback();
            return res.status(400).json({
                success: false,
                error: `Solo se puede cambiar de paquete cuando el cliente no tiene adeudo ni saldo a favor. Adeudo actual: $${adeudoActual.toFixed(2)}.`,
                adeudo_actual: adeudoActual
            });
        }

        const saldoFavor = parseFloat(estadoCuenta.saldo_favor) || 0;
        if (saldoFavor > 0) {
            await connection.rollback();
            return res.status(400).json({
                success: false,
                error: `Solo se puede cambiar de paquete cuando el cliente no tiene adeudo ni saldo a favor. Saldo a favor actual: $${saldoFavor.toFixed(2)}.`,
                saldo_favor: saldoFavor
            });
        }

        const restriccionCambio = obtenerRestriccionCambioPaquete(historialPaquetesCuenta, hoyLocal);
        if (restriccionCambio.bloqueado) {
            await connection.rollback();
            return res.status(400).json({
                success: false,
                error: `El cliente ya tuvo un cambio de paquete reciente. Podra cambiar nuevamente a partir del ${restriccionCambio.fecha_proximo_cambio}.`,
                fecha_ultimo_cambio: restriccionCambio.fecha_ultimo_cambio,
                fecha_proximo_cambio: restriccionCambio.fecha_proximo_cambio,
                dias_restantes: restriccionCambio.dias_restantes
            });
        }

        const [historialActivoRows] = await connection.query(
            `SELECT h.id, h.paquete_id, h.costo_mensual, h.fecha_inicio,
                    p.nombre_paquete, p.velocidad_mbps
             FROM cliente_paquetes_historial h
             JOIN paquetes p ON p.id = h.paquete_id
             WHERE h.cliente_id = ? AND h.fecha_fin IS NULL
             ORDER BY h.fecha_inicio DESC, h.id DESC
             LIMIT 1
             FOR UPDATE`,
            [clienteId]
        );

        let historialActivo = historialActivoRows[0] || null;
        if (!historialActivo && cliente.paquete_id) {
            const fechaInicioInicial = fechaInstalacion || hoyLocal;
            const [insertInicial] = await connection.query(
                `INSERT INTO cliente_paquetes_historial
                    (cliente_id, paquete_id, costo_mensual, fecha_inicio, fecha_fin, usuario_id)
                 VALUES (?, ?, ?, ?, NULL, NULL)`,
                [clienteId, cliente.paquete_id, cliente.costo_mensual, formatearFechaSql(fechaInicioInicial)]
            );

            historialActivo = {
                id: insertInicial.insertId,
                paquete_id: cliente.paquete_id,
                costo_mensual: cliente.costo_mensual,
                fecha_inicio: formatearFechaSql(fechaInicioInicial),
                nombre_paquete: cliente.paquete || 'Paquete anterior'
            };
        }

        if (!historialActivo) {
            await connection.rollback();
            return res.status(400).json({
                success: false,
                error: 'El cliente no tiene paquete actual para cerrar historial.'
            });
        }

        const mismoPaquete = parseInt(historialActivo.paquete_id, 10) === parseInt(paqueteSeleccionado.id, 10);
        const mismoCosto = Number(parseFloat(historialActivo.costo_mensual).toFixed(2)) === Number(costoMensual.toFixed(2));
        if (mismoPaquete && mismoCosto) {
            await connection.rollback();
            return res.status(400).json({ success: false, error: 'El cliente ya tiene ese paquete y costo.' });
        }

        const fechaInicioActivo = crearFechaLocalDesdeValor(historialActivo.fecha_inicio);
        if (fechaInicioActivo && fechaInicio < fechaInicioActivo) {
            await connection.rollback();
            return res.status(400).json({
                success: false,
                error: 'La fecha de inicio no puede ser anterior al inicio del paquete actual.'
            });
        }

        const fechaFinAnterior = fechaInicioActivo && formatearFechaSql(fechaInicioActivo) === formatearFechaSql(fechaInicio)
            ? fechaInicio
            : restarDiasFecha(fechaInicio, 1);
        const diaPago = normalizarDiaPago(cliente.dia_pago) || obtenerDiaPagoDesdeFechaInstalacion(cliente.fecha_instalacion) || 1;
        const costoAnterior = parseFloat(historialActivo.costo_mensual) || parseFloat(cliente.costo_mensual) || 0;
        const diasRestantes = calcularDiasRestantesHastaCorte(fechaInicio, diaPago);
        const prorrateo = calcularProrrateoCambioPaquete(costoAnterior, costoMensual, diasRestantes);
        const resultadoProrrateo = prorrateo.tipo_prorrateo === 'cargo'
            ? 'Cargo por prorrateo'
            : prorrateo.tipo_prorrateo === 'saldo_favor'
                ? 'Saldo a favor'
                : 'Sin prorrateo';
        const observacionCambioPaquete = [
            `Paquete anterior: ${historialActivo.nombre_paquete || cliente.paquete || 'N/A'}`,
            `Paquete nuevo: ${paqueteSeleccionado.nombre_paquete}`,
            `Costo anterior: $${costoAnterior.toFixed(2)}`,
            `Costo nuevo: $${costoMensual.toFixed(2)}`,
            `Dia de corte: ${diaPago}`,
            `Dias prorrateados: ${prorrateo.dias_restantes}`,
            `Diferencia mensual: $${prorrateo.diferencia_mensual.toFixed(2)}`,
            `Resultado: ${resultadoProrrateo}`,
            `Monto prorrateo: $${prorrateo.monto_prorrateo.toFixed(2)}`,
            'Validacion de velocidad: https://wifiman.com/'
        ].join(' | ');

        await connection.query(
            'UPDATE cliente_paquetes_historial SET fecha_fin = ? WHERE id = ?',
            [formatearFechaSql(fechaFinAnterior), historialActivo.id]
        );

        await connection.query(
            `INSERT INTO cliente_paquetes_historial
                (cliente_id, paquete_id, costo_mensual, fecha_inicio, fecha_fin, usuario_id)
             VALUES (?, ?, ?, ?, NULL, ?)`,
            [
                clienteId,
                paqueteSeleccionado.id,
                costoMensual,
                formatearFechaSql(fechaInicio),
                parseInt(usuario_id, 10) || null
            ]
        );

        await connection.query(
            `UPDATE clientes
             SET paquete_id = ?, paquete = ?, costo_mensual = ?
             WHERE id = ?`,
            [paqueteSeleccionado.id, paqueteSeleccionado.nombre_paquete, costoMensual, clienteId]
        );

        const columnaObservaciones = await obtenerColumnaObservacionesBitacora(connection);
        const camposObservacion = columnaObservaciones ? `, ${escaparIdentificadorMysql(columnaObservaciones)}` : '';
        const valoresObservacion = columnaObservaciones ? ', ?' : '';
        const paramsBitacora = [
            clienteId,
            prorrateo.dias_restantes,
            prorrateo.monto_ajuste
        ];
        if (columnaObservaciones) paramsBitacora.push(observacionCambioPaquete);

        await connection.query(
            `INSERT INTO bitacora_servicio
                (cliente_id, tipo_evento, fecha_inicio, fecha_fin, dias_compensados, monto_ajuste, estado${camposObservacion})
             VALUES (?, 'cambio_paquete', NOW(), NOW(), ?, ?, 'Finalizado'${valoresObservacion})`,
            paramsBitacora
        );

        await connection.commit();

        res.json({
            success: true,
            message: 'Paquete actualizado correctamente.',
            paquete_anterior: {
                id: historialActivo.paquete_id,
                nombre_paquete: historialActivo.nombre_paquete || cliente.paquete || 'Paquete anterior',
                costo_mensual: costoAnterior
            },
            paquete: {
                id: paqueteSeleccionado.id,
                nombre_paquete: paqueteSeleccionado.nombre_paquete,
                costo_mensual: costoMensual,
                fecha_inicio: formatearFechaSql(fechaInicio)
            },
            fecha_inicio: formatearFechaSql(fechaInicio),
            dia_pago: diaPago,
            dias_prorrateo: prorrateo.dias_restantes,
            diferencia_mensual: prorrateo.diferencia_mensual,
            tipo_prorrateo: prorrateo.tipo_prorrateo,
            monto_prorrateo: prorrateo.monto_prorrateo,
            monto_ajuste: prorrateo.monto_ajuste,
            observaciones_guardadas: observacionCambioPaquete,
            validacion_velocidad_url: 'https://wifiman.com/'
        });
    } catch (error) {
        try {
            await connection.rollback();
        } catch (rollbackError) {
            console.error('Error al revertir cambio de paquete:', rollbackError);
        }
        console.error('Error al cambiar paquete:', error);
        res.status(500).json({ success: false, error: error.message });
    } finally {
        connection.release();
    }
});

app.post('/api/clientes/:id/suspender-servicio', async (req, res) => {
    const clienteId = req.params.id;
    const { tipo_evento, dias_compensados, fecha_inicio, fecha_fin, observaciones, nuevo_dia_pago, accion_prorrateo, monto_prorrateo } = req.body;
    const tiposValidos = ['falta_pago', 'decision_usuario', 'falla_tecnica', 'cambio_fecha_pago'];

    try {
        await finalizarAusenciasProgramadasVencidas(db, clienteId);

        if (!tiposValidos.includes(tipo_evento)) {
            return res.status(400).json({ success: false, error: 'Tipo de suspension no valido.' });
        }

        const [activos] = await db.query(
            'SELECT id FROM bitacora_servicio WHERE cliente_id = ? AND estado = "Activo" LIMIT 1',
            [clienteId]
        );

        if (activos.length > 0 && tipo_evento !== 'falla_tecnica') {
            return res.status(400).json({ success: false, error: 'El cliente ya tiene una suspension activa.' });
        }

        if (tipo_evento === 'falta_pago') {
            const [clienteRows] = await db.query(
                'SELECT costo_mensual, fecha_instalacion, dia_pago FROM clientes WHERE id = ?',
                [clienteId]
            );

            if (clienteRows.length === 0) {
                return res.status(404).json({ success: false, error: 'Cliente no encontrado.' });
            }

            const [pagos] = await db.query(
                'SELECT mes_pagado, monto FROM pagos WHERE cliente_id = ? AND estado_corte < 3',
                [clienteId]
            );
            const bitacora = await consultarBitacoraServicio(db, clienteId);
            const historialPaquetes = await consultarHistorialPaquetes(db, clienteId);
            const estadoCuenta = calcularEstadoCuentaServidor(clienteRows[0], pagos, bitacora, historialPaquetes);

            if ((parseFloat(estadoCuenta.adeudo_actual) || 0) <= 0) {
                return res.status(400).json({
                    success: false,
                    error: 'Solo se puede suspender por falta de pago cuando el cliente tiene adeudo pendiente.'
                });
            }
        }

        if (tipo_evento === 'cambio_fecha_pago') {
            const nuevoDiaPago = parseInt(nuevo_dia_pago);
            const accion = String(accion_prorrateo || 'sin_ajuste').trim();
            const accionesValidas = ['cargo', 'sin_ajuste'];
            const montoAbsoluto = Number(Math.abs(parseFloat(monto_prorrateo) || 0).toFixed(2));
            const observacionesLimpias = (observaciones || '').trim();

            if (!accionesValidas.includes(accion)) {
                return res.status(400).json({ success: false, error: 'La decision de prorrateo no es valida.' });
            }

            if (!nuevoDiaPago || nuevoDiaPago < 1 || nuevoDiaPago > 31) {
                return res.status(400).json({ success: false, error: 'El nuevo dia de pago debe estar entre 1 y 31.' });
            }

            if (accion !== 'sin_ajuste' && montoAbsoluto <= 0) {
                return res.status(400).json({ success: false, error: 'Captura el monto del prorrateo.' });
            }

            const connection = await db.getConnection();

            try {
                await connection.beginTransaction();

                const [clienteRows] = await connection.query(
                    'SELECT costo_mensual, fecha_instalacion, dia_pago, estado_servicio FROM clientes WHERE id = ? FOR UPDATE',
                    [clienteId]
                );

                if (clienteRows.length === 0) {
                    await connection.rollback();
                    return res.status(404).json({ success: false, error: 'Cliente no encontrado.' });
                }

                const cliente = clienteRows[0];
                const diaAnterior = parseInt(cliente.dia_pago) || obtenerDiaPagoDesdeFechaInstalacion(cliente.fecha_instalacion) || 1;

                if (nuevoDiaPago === diaAnterior) {
                    await connection.rollback();
                    return res.status(400).json({ success: false, error: 'El nuevo dia de pago es igual al dia actual.' });
                }

                if (String(cliente.estado_servicio || '').toLowerCase() !== 'activo') {
                    await connection.rollback();
                    return res.status(400).json({ success: false, error: 'Solo se puede cambiar la fecha de pago con el servicio activo.' });
                }

                const [pagos] = await connection.query(
                    'SELECT mes_pagado, monto FROM pagos WHERE cliente_id = ? AND estado_corte < 3',
                    [clienteId]
                );
                const bitacora = await consultarBitacoraServicio(connection, clienteId);
                const historialPaquetes = await consultarHistorialPaquetes(connection, clienteId);
                const estadoCuenta = calcularEstadoCuentaServidor(cliente, pagos, bitacora, historialPaquetes);

                if ((parseFloat(estadoCuenta.adeudo_actual) || 0) > 0) {
                    await connection.rollback();
                    return res.status(400).json({
                        success: false,
                        error: 'Solo se puede cambiar la fecha de pago cuando el cliente esta al corriente.'
                    });
                }

                const diasProrrateo = calcularDiasProrrateoCambioPago(diaAnterior, nuevoDiaPago);
                const montoAjuste = accion === 'cargo' ? -montoAbsoluto : 0;
                const accionTexto = accion === 'cargo' ? 'Cargo al cliente' : 'Sin cobro';
                const observacionFinal = [
                    `Dia anterior: ${diaAnterior}`,
                    `Nuevo dia: ${nuevoDiaPago}`,
                    `Dias prorrateo: ${diasProrrateo}`,
                    `Decision: ${accionTexto}`,
                    `Monto prorrateo: $${montoAbsoluto.toFixed(2)}`,
                    observacionesLimpias
                ].filter(Boolean).join(' | ');

                const columnaObservaciones = await obtenerColumnaObservacionesBitacora(connection);
                const camposObservacion = columnaObservaciones ? `, ${escaparIdentificadorMysql(columnaObservaciones)}` : '';
                const valoresObservacion = columnaObservaciones ? ', ?' : '';
                const paramsBitacora = [clienteId, tipo_evento, montoAjuste];
                if (columnaObservaciones) paramsBitacora.push(observacionFinal);

                const [resultadoInsert] = await connection.query(
                    `INSERT INTO bitacora_servicio
                        (cliente_id, tipo_evento, fecha_inicio, fecha_fin, dias_compensados, monto_ajuste, estado${camposObservacion})
                     VALUES (?, ?, NOW(), NOW(), 0, ?, 'Finalizado'${valoresObservacion})`,
                    paramsBitacora
                );

                await connection.query(
                    'UPDATE clientes SET dia_pago = ? WHERE id = ?',
                    [nuevoDiaPago, clienteId]
                );

                await connection.commit();

                return res.json({
                    success: true,
                    message: 'Fecha de pago actualizada correctamente.',
                    bitacora_id: resultadoInsert.insertId,
                    tipo_evento,
                    dia_pago_anterior: diaAnterior,
                    nuevo_dia_pago: nuevoDiaPago,
                    dias_prorrateo: diasProrrateo,
                    accion_prorrateo: accion,
                    monto_ajuste: montoAjuste,
                    observaciones_guardadas: observacionFinal
                });
            } catch (error) {
                await connection.rollback();
                throw error;
            } finally {
                connection.release();
            }
        }

        if (tipo_evento === 'falla_tecnica') {
            const dias = parseInt(dias_compensados) || 0;
            const observacionesLimpias = (observaciones || '').trim();

            if (!fecha_inicio || !fecha_fin) {
                return res.status(400).json({ success: false, error: 'Captura fecha inicio y fecha fin de la falla tecnica.' });
            }

            if (dias <= 0) {
                return res.status(400).json({ success: false, error: 'Indica los dias compensados de la falla tecnica.' });
            }

            if (!observacionesLimpias) {
                return res.status(400).json({ success: false, error: 'Agrega observaciones sobre la falla tecnica.' });
            }

            const [clienteRows] = await db.query(
                'SELECT costo_mensual FROM clientes WHERE id = ?',
                [clienteId]
            );

            if (clienteRows.length === 0) {
                return res.status(404).json({ success: false, error: 'Cliente no encontrado.' });
            }

            const montoAjuste = calcularMontoAjuste(clienteRows[0].costo_mensual, dias);
            const columnaObservaciones = await obtenerColumnaObservacionesBitacora(db);

            if (!columnaObservaciones) {
                return res.status(500).json({
                    success: false,
                    error: 'No existe la columna observaciones en bitacora_servicio.'
                });
            }

            const [resultadoInsert] = await db.query(
                `INSERT INTO bitacora_servicio
                    (cliente_id, tipo_evento, fecha_inicio, fecha_fin, dias_compensados, monto_ajuste, estado, ${escaparIdentificadorMysql(columnaObservaciones)})
                 VALUES (?, ?, ?, ?, ?, ?, 'Finalizado', ?)`,
                [clienteId, tipo_evento, fecha_inicio, fecha_fin, dias, montoAjuste, observacionesLimpias]
            );

            return res.json({
                success: true,
                message: 'Falla tecnica registrada.',
                bitacora_id: resultadoInsert.insertId,
                fecha_inicio,
                fecha_fin,
                dias_compensados: dias,
                monto_ajuste: montoAjuste,
                observaciones_guardadas: observacionesLimpias
            });
        }

        if (tipo_evento === 'decision_usuario') {
            const dias = parseInt(dias_compensados) || 0;

            if (dias <= 0) {
                return res.status(400).json({ success: false, error: 'Indica los dias de ausencia del cliente.' });
            }

            const [clienteRows] = await db.query(
                'SELECT costo_mensual, fecha_instalacion, dia_pago FROM clientes WHERE id = ?',
                [clienteId]
            );

            if (clienteRows.length === 0) {
                return res.status(404).json({ success: false, error: 'Cliente no encontrado.' });
            }

            const [pagos] = await db.query(
                'SELECT mes_pagado, monto FROM pagos WHERE cliente_id = ? AND estado_corte < 3',
                [clienteId]
            );
            const bitacora = await consultarBitacoraServicio(db, clienteId);
            const historialPaquetes = await consultarHistorialPaquetes(db, clienteId);
            const estadoCuenta = calcularEstadoCuentaServidor(
                {
                    costo_mensual: clienteRows[0].costo_mensual,
                    fecha_instalacion: clienteRows[0].fecha_instalacion,
                    dia_pago: clienteRows[0].dia_pago
                },
                pagos,
                bitacora,
                historialPaquetes
            );

            if ((parseFloat(estadoCuenta.adeudo_actual) || 0) > 0) {
                return res.status(400).json({
                    success: false,
                    error: 'Solo se puede registrar ausencia del cliente cuando esta al corriente.'
                });
            }

            const fechaInicioAusencia = fecha_inicio ? new Date(fecha_inicio) : new Date();
            const fechaFinAusencia = fecha_fin ? new Date(fecha_fin) : sumarDias(fechaInicioAusencia, dias);
            const montoAjuste = calcularMontoAjuste(clienteRows[0].costo_mensual, dias);

            await db.query(
                `INSERT INTO bitacora_servicio
                    (cliente_id, tipo_evento, fecha_inicio, fecha_fin, dias_compensados, monto_ajuste, estado)
                 VALUES (?, ?, ?, ?, ?, ?, 'Activo')`,
                [clienteId, tipo_evento, fechaInicioAusencia, fechaFinAusencia, dias, montoAjuste]
            );

            await db.query(
                'UPDATE clientes SET estado_servicio = ? WHERE id = ?',
                ['Suspendido', clienteId]
            );

            return res.json({
                success: true,
                message: 'Ausencia del cliente registrada correctamente.',
                dias_compensados: dias,
                fecha_inicio: fechaInicioAusencia,
                fecha_fin: fechaFinAusencia,
                monto_ajuste: montoAjuste
            });
        }

        const fechaInicioSuspension = new Date();

        await db.query(
            `INSERT INTO bitacora_servicio
                (cliente_id, tipo_evento, fecha_inicio, fecha_fin, dias_compensados, monto_ajuste, estado)
             VALUES (?, ?, ?, NULL, 0, 0.00, 'Activo')`,
            [clienteId, tipo_evento, fechaInicioSuspension]
        );

        await db.query(
            'UPDATE clientes SET estado_servicio = ? WHERE id = ?',
            ['Suspendido', clienteId]
        );

        res.json({
            success: true,
            message: 'Servicio suspendido correctamente.',
            tipo_evento,
            fecha_inicio: fechaInicioSuspension,
            dias_compensados: 0,
            monto_ajuste: 0
        });
    } catch (error) {
        console.error('Error al suspender servicio:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/clientes/:id/reactivar-servicio', async (req, res) => {
    const clienteId = req.params.id;

    try {
        await finalizarAusenciasProgramadasVencidas(db, clienteId);

        const [activos] = await db.query(
            'SELECT * FROM bitacora_servicio WHERE cliente_id = ? AND estado = "Activo" ORDER BY id DESC LIMIT 1',
            [clienteId]
        );

        if (activos.length === 0) {
            return res.status(404).json({ success: false, error: 'No hay suspension activa para este cliente.' });
        }

        const evento = activos[0];
        let fechaFinServicio = new Date();
        let diasCompensados = 0;
        let montoAjuste = 0;

        if (evento.tipo_evento === 'decision_usuario') {
            const fechaFinProgramada = evento.fecha_fin ? new Date(evento.fecha_fin) : new Date();
            fechaFinServicio = new Date() < fechaFinProgramada ? new Date() : fechaFinProgramada;
            diasCompensados = calcularDiasEntre(evento.fecha_inicio, fechaFinServicio);

            const [clienteRows] = await db.query(
                'SELECT costo_mensual FROM clientes WHERE id = ?',
                [clienteId]
            );
            montoAjuste = calcularMontoAjuste(clienteRows[0]?.costo_mensual, diasCompensados);
        }

        await db.query(
            `UPDATE bitacora_servicio
             SET fecha_fin = ?, dias_compensados = ?, monto_ajuste = ?, estado = 'Finalizado'
             WHERE id = ?`,
            [fechaFinServicio, diasCompensados, montoAjuste, evento.id]
        );

        await db.query(
            'UPDATE clientes SET estado_servicio = ? WHERE id = ?',
            ['activo', clienteId]
        );

        res.json({
            success: true,
            message: 'Servicio reactivado correctamente.',
            tipo_evento: evento.tipo_evento,
            fecha_inicio: evento.fecha_inicio,
            fecha_fin: fechaFinServicio,
            dias_compensados: diasCompensados,
            monto_ajuste: montoAjuste
        });
    } catch (error) {
        console.error('Error al reactivar servicio:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/clientes/:id/dar-baja', async (req, res) => {
    const clienteId = req.params.id;
    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();

        const [clienteRows] = await connection.query(
            'SELECT id, nombre_completo, estado_servicio FROM clientes WHERE id = ? FOR UPDATE',
            [clienteId]
        );

        if (clienteRows.length === 0) {
            await connection.rollback();
            return res.status(404).json({ success: false, error: 'Cliente no encontrado.' });
        }

        const [activos] = await connection.query(
            `SELECT id, tipo_evento
             FROM bitacora_servicio
             WHERE cliente_id = ? AND estado = 'Activo' AND tipo_evento = 'falta_pago'
             ORDER BY id DESC
             LIMIT 1`,
            [clienteId]
        );

        if (activos.length === 0) {
            await connection.rollback();
            return res.status(400).json({
                success: false,
                error: 'Solo se puede dar de baja desde una suspension activa por falta de pago.'
            });
        }

        await connection.query(
            `UPDATE bitacora_servicio
             SET fecha_fin = NOW(), dias_compensados = 0, monto_ajuste = 0, estado = 'Finalizado'
             WHERE id = ?`,
            [activos[0].id]
        );

        await connection.query(
            'UPDATE clientes SET estado_servicio = ? WHERE id = ?',
            ['baja', clienteId]
        );

        await connection.commit();

        res.json({
            success: true,
            message: 'Cliente dado de baja correctamente.'
        });
    } catch (error) {
        await connection.rollback();
        console.error('Error al dar de baja cliente:', error);
        res.status(500).json({ success: false, error: error.message });
    } finally {
        connection.release();
    }
});

app.post('/api/clientes/:id/reactivar-con-pago', async (req, res) => {
    const clienteId = req.params.id;
    const { usuarioId, montoRecibido } = req.body;
    const connection = await db.getConnection();

    try {
        const montoTotalRecibido = parseFloat(montoRecibido);

        if (!montoTotalRecibido || montoTotalRecibido <= 0) {
            return res.status(400).json({ success: false, error: 'Monto invalido.' });
        }

        await connection.beginTransaction();

        const [clienteRows] = await connection.query(
            'SELECT costo_mensual, fecha_instalacion, dia_pago FROM clientes WHERE id = ?',
            [clienteId]
        );

        if (clienteRows.length === 0) {
            await connection.rollback();
            return res.status(404).json({ success: false, error: 'Cliente no encontrado.' });
        }

        const [activos] = await connection.query(
            `SELECT * FROM bitacora_servicio
             WHERE cliente_id = ? AND estado = 'Activo' AND tipo_evento = 'falta_pago'
             ORDER BY id DESC LIMIT 1`,
            [clienteId]
        );

        if (activos.length === 0) {
            await connection.rollback();
            return res.status(400).json({ success: false, error: 'No hay suspension activa por falta de pago.' });
        }

        const [pagosExistentes] = await connection.query(
            'SELECT mes_pagado, monto FROM pagos WHERE cliente_id = ? AND estado_corte < 3',
            [clienteId]
        );

        const bitacora = await consultarBitacoraServicio(connection, clienteId);

        const clienteData = clienteRows[0];
        const costoMensual = parseFloat(clienteData.costo_mensual) || 0;
        const historialPaquetes = await consultarHistorialPaquetes(connection, clienteId);
        const estadoCuenta = calcularEstadoCuentaServidor(clienteData, pagosExistentes, bitacora, historialPaquetes);
        const cambiosFechaPago = obtenerCambiosFechaPago(bitacora);
        const minimoReactivacion = parseFloat(estadoCuenta.adeudo_actual) || 0;

        if (montoTotalRecibido < minimoReactivacion) {
            await connection.rollback();
            return res.status(400).json({
                success: false,
                error: `Para reactivar debe cubrir ${minimoReactivacion.toFixed(2)} de adeudo.`
            });
        }

        const historial = {};
        pagosExistentes.forEach(pago => {
            historial[pago.mes_pagado] = (historial[pago.mes_pagado] || 0) + (parseFloat(pago.monto) || 0);
        });

        let saldoRestante = montoTotalRecibido;
        let ajustePendienteDisponible = parseFloat(estadoCuenta.monto_ajustes_pendientes) || 0;
        const registros = [];
        const aplicarPagoMes = async (etiquetaMes, pendienteMes, ajusteAAplicar = 0, montoEsperadoMes = costoMensual) => {
            const pagadoAntes = historial[etiquetaMes] || 0;
            const montoAAplicar = Math.min(saldoRestante, pendienteMes);
            let nuevoTipo = (montoAAplicar >= pendienteMes && pagadoAntes === 0) ? 'completo' : 'abono';

            if (pagadoAntes + montoAAplicar + ajusteAAplicar >= montoEsperadoMes) nuevoTipo = 'completo';

            const [pagoResult] = await connection.query(
                'INSERT INTO pagos (cliente_id, usuario_id, monto, mes_pagado, tipo_pago) VALUES (?, ?, ?, ?, ?)',
                [clienteId, usuarioId, montoAAplicar, etiquetaMes, nuevoTipo]
            );

            const ajusteAplicado = await aplicarAjustesPendientes(connection, clienteId, etiquetaMes, ajusteAAplicar, pagoResult.insertId);

            registros.push({
                mes: etiquetaMes,
                monto: montoAAplicar,
                tipo: nuevoTipo,
                ajuste_aplicado: ajusteAplicado
            });
            saldoRestante -= montoAAplicar;
            historial[etiquetaMes] = pagadoAntes + montoAAplicar;
            ajustePendienteDisponible = Number(Math.max(ajustePendienteDisponible - ajusteAplicado, 0).toFixed(2));
        };

        const aplicarPagoCargo = async (cargo) => {
            const pendienteCargo = parseFloat(cargo.pendiente) || 0;
            const montoAAplicar = Math.min(saldoRestante, pendienteCargo);
            if (montoAAplicar <= 0) return;

            const nuevoTipo = montoAAplicar >= pendienteCargo ? 'completo' : 'abono';
            const etiquetaCargo = cargo.mes || obtenerEtiquetaCargoServicio(cargo.tipo_evento);
            const clavePagoCargo = cargo.clave_pago || obtenerClavePagoCargoServicio(cargo.tipo_evento);
            const [pagoResult] = await connection.query(
                'INSERT INTO pagos (cliente_id, usuario_id, monto, mes_pagado, tipo_pago) VALUES (?, ?, ?, ?, ?)',
                [clienteId, usuarioId, montoAAplicar, clavePagoCargo, nuevoTipo]
            );

            const cargoAplicado = await aplicarCargosPendientes(connection, clienteId, clavePagoCargo, montoAAplicar, pagoResult.insertId);

            registros.push({
                mes: etiquetaCargo,
                mes_registrado: clavePagoCargo,
                monto: montoAAplicar,
                tipo: nuevoTipo,
                cargo_aplicado: cargoAplicado,
                es_cargo: true,
                observaciones: cargo.observaciones || ''
            });
            saldoRestante -= montoAAplicar;
        };

        for (const mesAdeudado of estadoCuenta.meses_adeudados) {
            if (saldoRestante <= 0) break;

            if (mesAdeudado.tipo === 'cargo_servicio') {
                await aplicarPagoCargo(mesAdeudado);
                continue;
            }

            const ajusteAAplicar = Math.min(ajustePendienteDisponible, parseFloat(mesAdeudado.monto_ajuste_pendiente) || 0);

            if ((parseFloat(mesAdeudado.pendiente) || 0) <= 0 && ajusteAAplicar > 0) {
                const ajusteAplicado = await aplicarAjustesPendientes(connection, clienteId, mesAdeudado.mes, ajusteAAplicar);
                registros.push({
                    mes: mesAdeudado.mes,
                    monto: 0,
                    tipo: 'ajuste',
                    ajuste_aplicado: ajusteAplicado
                });
                ajustePendienteDisponible = Number(Math.max(ajustePendienteDisponible - ajusteAplicado, 0).toFixed(2));
                continue;
            }

            await aplicarPagoMes(
                mesAdeudado.mes,
                mesAdeudado.pendiente,
                ajusteAAplicar,
                parseFloat(mesAdeudado.monto_esperado) || costoMensual
            );
        }

        await connection.query(
            `UPDATE bitacora_servicio
             SET fecha_fin = NOW(), dias_compensados = ?, monto_ajuste = ?, estado = 'Finalizado'
             WHERE id = ?`,
            [0, 0, activos[0].id]
        );

        await connection.query(
            'UPDATE clientes SET estado_servicio = ? WHERE id = ?',
            ['activo', clienteId]
        );

        const ultimoMesVencido = estadoCuenta.meses_vencidos[estadoCuenta.meses_vencidos.length - 1];
        let cursor;

        if (ultimoMesVencido) {
            const [nombreMes, anioTexto] = ultimoMesVencido.split(' ');
            const nombresMeses = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
            cursor = avanzarMesContable(parseInt(anioTexto), nombresMeses.indexOf(nombreMes), 1);
        } else {
            const fechaInstalacion = crearFechaLocalDesdeValor(clienteData.fecha_instalacion) || new Date();
            cursor = avanzarMesContable(fechaInstalacion.getFullYear(), fechaInstalacion.getMonth(), 1);
        }

        const anioLimite = new Date().getFullYear() + 2;

        while (saldoRestante > 0 && cursor.anio <= anioLimite) {
            const reglaPagoMes = obtenerReglaPagoParaMes(cursor.anio, cursor.mesIndex, clienteData.dia_pago, cambiosFechaPago);
            if (reglaPagoMes.omitir_mes) {
                cursor = avanzarMesContable(cursor.anio, cursor.mesIndex, 1);
                continue;
            }

            const etiquetaMes = obtenerEtiquetaMes(cursor.anio, cursor.mesIndex);
            const pagadoEnEsteMes = historial[etiquetaMes] || 0;
            const costoMes = obtenerCostoMensualParaMes(historialPaquetes, cursor.anio, cursor.mesIndex, costoMensual);
            const ajusteAAplicar = Math.min(ajustePendienteDisponible, Math.max(costoMes - pagadoEnEsteMes, 0));
            const pendienteMes = Math.max(costoMes - pagadoEnEsteMes - ajusteAAplicar, 0);

            if (pendienteMes <= 0 && ajusteAAplicar > 0) {
                const ajusteAplicado = await aplicarAjustesPendientes(db, clienteId, etiquetaMes, ajusteAAplicar);
                registros.push({
                    mes: etiquetaMes,
                    monto: 0,
                    tipo: 'ajuste',
                    ajuste_aplicado: ajusteAplicado
                });
                ajustePendienteDisponible = Number(Math.max(ajustePendienteDisponible - ajusteAplicado, 0).toFixed(2));
                cursor = avanzarMesContable(cursor.anio, cursor.mesIndex, 1);
                continue;
            }

            if (pendienteMes > 0) {
                await aplicarPagoMes(etiquetaMes, pendienteMes, ajusteAAplicar, costoMes);
            }

            cursor = avanzarMesContable(cursor.anio, cursor.mesIndex, 1);
        }

        await connection.commit();

        res.json({
            success: true,
            message: 'Servicio reactivado y pago registrado correctamente.',
            detalle: registros,
            dias_compensados: 0
        });
    } catch (error) {
        await connection.rollback();
        console.error('Error al reactivar con pago:', error);
        res.status(500).json({ success: false, error: error.message });
    } finally {
        connection.release();
    }
});

// =======================================================
// RUTAS DE LECTURA DE CORTE (ACTUALIZADAS - PASO 3)
// =======================================================

// 1. Obtener el Corte Actual (El día a día del cobrador)
app.get('/api/corte-caja/:usuarioId', async (req, res) => {
    const { usuarioId } = req.params;
    try {
        // 1. Rescatamos el Saldo Inicial (Monto retenido del último corte cerrado)
        const [ultimoCorte] = await db.query(
            'SELECT monto_retenido, monto_entregado FROM cortes_caja WHERE usuario_id = ? ORDER BY id DESC LIMIT 1',
            [usuarioId]
        );
        const saldoInicial = ultimoCorte.length > 0 ? parseFloat(ultimoCorte[0].monto_retenido) : 0.00;
        const montoEntregado = ultimoCorte.length > 0 ? parseFloat(ultimoCorte[0].monto_entregado) : 0.00;
        // 2. Obtener los pagos pendientes (Mensualidades exclusivas de clientes)
        const [detalles] = await db.query(
            `SELECT p.id, p.fecha_pago, c.nombre_completo as cliente, COALESCE(c.codigo_cliente, c.direccion_ip) as ip, p.mes_pagado, p.monto, p.estado_corte 
             FROM pagos p 
             JOIN clientes c ON p.cliente_id = c.id 
             WHERE p.usuario_id = ? AND p.estado_corte IN (0, 3)
             ORDER BY p.id DESC`,
            [usuarioId]
        );

        // 3. Obtener los gastos pendientes
        const [gastos] = await db.query(
            `SELECT id, fecha_gasto, descripcion, monto, estado_corte 
             FROM gastos 
             WHERE usuario_id = ? AND estado_corte IN (0, 3) 
             ORDER BY id DESC`,
            [usuarioId]
        );

        // 4. NUEVO: Obtener los ingresos extra pendientes
        const [ingresosExtra] = await db.query(
            `SELECT id, fecha_ingreso, descripcion, monto, estado_corte 
             FROM ingresos_extra 
             WHERE usuario_id = ? AND estado_corte IN (0, 3) 
             ORDER BY id DESC`,
            [usuarioId]
        );

        // Sumatorias para la caja
        let totalPagos = detalles.filter(d => parseInt(d.estado_corte) === 0).reduce((sum, d) => sum + parseFloat(d.monto), 0);
        let totalGastos = gastos.filter(g => parseInt(g.estado_corte) === 0).reduce((sum, g) => sum + parseFloat(g.monto), 0);
        let totalIngresos = ingresosExtra.filter(i => parseInt(i.estado_corte) === 0).reduce((sum, i) => sum + parseFloat(i.monto), 0);
        
        // FÓRMULA MAESTRA DE CAJA FÍSICA
        let totalCajaFisica = saldoInicial + totalPagos + totalIngresos - totalGastos;
        let totalCobrosNum = detalles.filter(d => parseInt(d.estado_corte) === 0).length;

        // Armamos el JSON final para mandarlo a la pantalla
        res.json({
            resumen: {
                saldo_inicial: saldoInicial,
                total_dinero: totalPagos, 
                total_ingresos_extra: totalIngresos,
                total_gastos: totalGastos,
                total_neto: totalCajaFisica, // Total en billetes y monedas que debe haber
                total_cobros: totalCobrosNum,
                monto_entregado: montoEntregado
            },
            detalles: detalles,
            gastos: gastos,
            ingresos_extra: ingresosExtra // Inyectamos la nueva lista
        });
    } catch (error) {
        console.error("Error al obtener corte actual:", error);
        res.status(500).json({ error: error.message });
    }
});

// 2. La Máquina del Tiempo (Cortes Históricos)
app.get('/api/corte-caja-historico/:corteId', async (req, res) => {
    const { corteId } = req.params;
    try {
        // A) Rescatamos el resumen guardado, incluyendo todos los campos nuevos de tu esquema
        const [resumenCorte] = await db.query(
            `SELECT saldo_inicial, total_cobrado as total_dinero, total_ingresos_extra, total_gastos, 
                    total_entregado as total_neto, monto_entregado, monto_retenido, fecha_corte 
             FROM cortes_caja WHERE id = ?`,
            [corteId]
        );

        if (resumenCorte.length === 0) {
            return res.status(404).json({ error: "Corte histórico no encontrado" });
        }

        // B) Buscamos los pagos amarrados a este candado
        const [detalles] = await db.query(
            `SELECT p.id, p.fecha_pago, c.nombre_completo as cliente, COALESCE(c.codigo_cliente, c.direccion_ip) as ip, p.mes_pagado, p.monto, p.estado_corte 
             FROM pagos p 
             JOIN clientes c ON p.cliente_id = c.id 
             WHERE p.corte_id = ? 
             ORDER BY p.id DESC`,
            [corteId]
        );

        // C) Buscamos los gastos amarrados
        const [gastos] = await db.query(
            `SELECT id, fecha_gasto, descripcion, monto, estado_corte
             FROM gastos
             WHERE corte_id = ?
             ORDER BY id DESC`,
            [corteId]
        );

        // D) NUEVO: Buscamos los ingresos extra amarrados a este candado
        const [ingresosExtra] = await db.query(
            `SELECT id, fecha_ingreso, descripcion, monto, estado_corte
             FROM ingresos_extra
             WHERE corte_id = ?
             ORDER BY id DESC`,
            [corteId]
        );

        resumenCorte[0].total_cobros = detalles.filter(d => parseInt(d.estado_corte) === 1).length;

        // E) Respondemos con la estructura idéntica a la ruta del día a día
        res.json({ 
            resumen: resumenCorte[0], 
            detalles: detalles, 
            gastos: gastos,
            ingresos_extra: ingresosExtra
        });
        
    } catch (error) {
        console.error("Error al obtener detalle histórico:", error);
        res.status(500).json({ error: error.message });
    }
});
/* 
// 1. Ruta para obtener el total y la lista de pagos sin entregar (estado_corte = 0)
app.get('/api/corte-caja/:usuarioId', async (req, res) => {
    const { usuarioId } = req.params;
    try {
        const [resumen] = await db.query(
            'SELECT COUNT(id) as total_cobros, SUM(monto) as total_dinero FROM pagos WHERE usuario_id = ? AND estado_corte = 0',
            [usuarioId]
        );
        const [detalles] = await db.query(
            `SELECT p.id, p.fecha_pago, c.nombre_completo as cliente, COALESCE(c.codigo_cliente, c.direccion_ip) as ip, p.mes_pagado, p.monto, p.estado_corte 
             FROM pagos p 
             JOIN clientes c ON p.cliente_id = c.id 
             WHERE p.usuario_id = ? AND p.estado_corte = 0  or p.usuario_id = 7  and p.estado_corte = 3
             ORDER BY p.id DESC`,
            [usuarioId]
        );
        const [gastos] = await db.query(
            `SELECT id, fecha_gasto, descripcion, monto, estado_corte
             FROM gastos
             WHERE usuario_id = ? AND estado_corte IN (0, 3)
             ORDER BY id DESC`,
            [usuarioId]
        );
        const totalGastos = gastos
            .filter(gasto => parseInt(gasto.estado_corte) === 0)
            .reduce((total, gasto) => total + (parseFloat(gasto.monto) || 0), 0);

        resumen[0].total_gastos = totalGastos;
        resumen[0].total_neto = (parseFloat(resumen[0].total_dinero) || 0) - totalGastos;

        //console.log("ok funciona")
        res.json({ resumen: resumen[0], detalles: detalles, gastos: gastos });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});
 */
/* app.post('/api/gastos', async (req, res) => {
    const { usuarioId, monto, descripcion } = req.body;

    try {
        const montoNumero = parseFloat(monto);
        const descripcionLimpia = (descripcion || '').trim();

        if (!usuarioId) {
            return res.status(400).json({ success: false, error: 'Usuario no válido.' });
        }

        if (!montoNumero || montoNumero <= 0) {
            return res.status(400).json({ success: false, error: 'El monto del gasto debe ser mayor a cero.' });
        }

        if (!descripcionLimpia) {
            return res.status(400).json({ success: false, error: 'La descripción del gasto es obligatoria.' });
        }

        const [usuarios] = await db.query(
            'SELECT rol_id FROM usuarios WHERE id = ? AND rol_id IN (1, 2, 3)',
            [usuarioId]
        );

        if (usuarios.length === 0) {
            return res.status(403).json({ success: false, error: 'Tu rol no tiene permisos para registrar gastos.' });
        }

        // 3. Consulta de Resumen de Caja (¡Aquí está la mejora!)
        // Se añaden los ingresos_extra a la consulta SQL. 
        // Nota: Asegúrate de que tu tabla se llame 'ingresos_extra'. Si tiene otro nombre, cámbialo en la línea 40.
        const [resumenCaja] = await db.query(
            `SELECT
                IFNULL((SELECT SUM(monto) FROM pagos WHERE usuario_id = ? AND estado_corte = 0), 0) AS total_pagos,
                IFNULL((SELECT SUM(monto) FROM ingresos_extra WHERE usuario_id = ? AND estado_corte = 0), 0) AS total_ingresos,
                IFNULL((SELECT SUM(monto) FROM gastos WHERE usuario_id = ? AND estado_corte = 0), 0) AS total_gastos`,
            [usuarioId, usuarioId, usuarioId] // Pasamos el usuarioId tres veces para las tres subconsultas
        );
        
        // 4. Extracción de valores individuales
        const totalPagos = parseFloat(resumenCaja[0].total_pagos) || 0;
        const totalIngresos = parseFloat(resumenCaja[0].total_ingresos) || 0;
        const totalGastos = parseFloat(resumenCaja[0].total_gastos) || 0;

        // Opcional: Si tienes un "Saldo Inicial" guardado en base de datos para este corte, 
        // deberías consultarlo arriba y sumarlo aquí. Por ejemplo: const saldoInicial = 2000;
        const saldoInicial = 0; // Cambia esto si lo obtienes de la BD para que coincida con tus $5,200 exactos.

        // 5. Cálculo real del efectivo disponible
        const efectivoDisponible = (totalPagos + totalIngresos + saldoInicial) - totalGastos;

        // 6. Candado de seguridad: Verificar si hay dinero suficiente
        if (efectivoDisponible <= 0) {
            return res.status(400).json({ success: false, error: 'No hay efectivo disponible en caja para registrar gastos.' });
        }
        if (montoNumero > efectivoDisponible) {
            return res.status(400).json({
                success: false,
                error: `El gasto excede el efectivo disponible ($${efectivoDisponible.toFixed(2)}).`
            });
        }

        const [result] = await db.query(
            'INSERT INTO gastos (usuario_id, monto, descripcion) VALUES (?, ?, ?)',
            [usuarioId, montoNumero, descripcionLimpia]
        );

        res.json({ success: true, id: result.insertId });
    } catch (error) {
        console.error('Error al registrar gasto:', error);
        res.status(500).json({ success: false, error: error.message });
    }
}); */


app.post('/api/gastos', async (req, res) => {
    const { usuarioId, monto, descripcion } = req.body;

    try {
        const montoNumero = parseFloat(monto);
        const descripcionLimpia = (descripcion || '').trim();

        if (!usuarioId) {
            return res.status(400).json({ success: false, error: 'Usuario no válido.' });
        }

        if (!montoNumero || montoNumero <= 0) {
            return res.status(400).json({ success: false, error: 'El monto del gasto debe ser mayor a cero.' });
        }

        if (!descripcionLimpia) {
            return res.status(400).json({ success: false, error: 'La descripción del gasto es obligatoria.' });
        }

        // 1. Verificamos permisos
        const [usuarios] = await db.query(
            'SELECT rol_id FROM usuarios WHERE id = ? AND rol_id IN (1, 2, 3)',
            [usuarioId]
        );

        if (usuarios.length === 0) {
            return res.status(403).json({ success: false, error: 'Tu rol no tiene permisos para registrar gastos.' });
        }

        // 2. NUEVO: Obtenemos el Saldo Inicial consultando el último corte cerrado/aprobado
        // Buscamos el último registro en la tabla cortes_caja para este usuario que esté aprobado (estado = 1)
        const [ultimoCorteCerrado] = await db.query(
            'SELECT monto_retenido FROM cortes_caja WHERE usuario_id = ? ORDER BY id DESC LIMIT 1',
            [usuarioId]
        );
        
        // Si existe un corte previo, extraemos el monto_retenido. Si no, arranca en 0.
        const saldoInicial = ultimoCorteCerrado.length > 0 ? parseFloat(ultimoCorteCerrado[0].monto_retenido) : 0.00;

        // 3. Consulta de Resumen de Caja del turno actual (estado_corte = 0)
        const [resumenCaja] = await db.query(
            `SELECT
                IFNULL((SELECT SUM(monto) FROM pagos WHERE usuario_id = ? AND estado_corte = 0), 0) AS total_pagos,
                IFNULL((SELECT SUM(monto) FROM ingresos_extra WHERE usuario_id = ? AND estado_corte = 0), 0) AS total_ingresos,
                IFNULL((SELECT SUM(monto) FROM gastos WHERE usuario_id = ? AND estado_corte = 0), 0) AS total_gastos`,
            [usuarioId, usuarioId, usuarioId]
        );
        
        // 4. Extracción de valores individuales
        const totalPagos = parseFloat(resumenCaja[0].total_pagos) || 0;
        const totalIngresos = parseFloat(resumenCaja[0].total_ingresos) || 0;
        const totalGastos = parseFloat(resumenCaja[0].total_gastos) || 0;

        // 5. Cálculo real del efectivo disponible (AHORA SÍ TOMA EN CUENTA EL SALDO INICIAL)
        const efectivoDisponible = (totalPagos + totalIngresos + saldoInicial) - totalGastos;

        // 6. Candado de seguridad: Verificar si hay dinero suficiente
        if (efectivoDisponible <= 0) {
            return res.status(400).json({ success: false, error: 'No hay efectivo disponible en caja para registrar gastos.' });
        }
        
        if (montoNumero > efectivoDisponible) {
            return res.status(400).json({
                success: false,
                error: `El gasto excede el efectivo disponible ($${efectivoDisponible.toFixed(2)}).`
            });
        }

        // 7. Si pasa todas las validaciones, se inserta el gasto
        const [result] = await db.query(
            'INSERT INTO gastos (usuario_id, monto, descripcion) VALUES (?, ?, ?)',
            [usuarioId, montoNumero, descripcionLimpia]
        );

        res.json({ success: true, id: result.insertId });
    } catch (error) {
        console.error('Error al registrar gasto:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});
app.post('/api/cancelar-gasto/:id', async (req, res) => {
    const idGasto = req.params.id;
    const { usuarioId } = req.body;

    try {
        const [result] = await db.query(
            'UPDATE gastos SET estado_corte = 3 WHERE id = ? AND usuario_id = ? AND estado_corte = 0',
            [idGasto, usuarioId]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, message: 'No se encontró el gasto pendiente.' });
        }

        res.json({ success: true, message: 'Gasto cancelado correctamente.' });
    } catch (error) {
        console.error('Error al cancelar gasto:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// 2. Ruta para AUTORIZAR y procesar el corte
app.post('/api/procesar-corte', async (req, res) => {
    // AHORA RECIBIMOS EL MONTO ENTREGADO DESDE EL FRONTEND
    const { usuarioId, adminUser, adminPassword, montoEntregado } = req.body;
    
    const connection = await db.getConnection();

    try {
        // A) Validamos al administrador
        const [admins] = await connection.query(
            'SELECT id FROM usuarios WHERE correo = ? AND password = ? AND rol_id = "2"', 
            [adminUser, adminPassword]
        );
        
        if (admins.length === 0) {
            connection.release();
            return res.status(401).json({ error: "Credenciales de administrador incorrectas." });
        }
        const adminId = admins[0].id;

        // B) INICIAMOS LA TRANSACCIÓN
        await connection.beginTransaction();

        // C) 1. Rescatamos el Saldo Inicial (Lo que quedó en la caja en el último corte)
        const [resSaldo] = await connection.query(
            'SELECT monto_retenido FROM cortes_caja WHERE usuario_id = ? ORDER BY id DESC LIMIT 1',
            [usuarioId]
        );
        const saldoInicial = resSaldo.length > 0 ? parseFloat(resSaldo[0].monto_retenido) : 0.00;

        // C) 2. Sumamos todos los rubros activos
        const [resPagos] = await connection.query('SELECT SUM(monto) as total FROM pagos WHERE usuario_id = ? AND estado_corte = 0', [usuarioId]);
        const totalCobrado = parseFloat(resPagos[0].total) || 0;

        const [resGastos] = await connection.query('SELECT SUM(monto) as total FROM gastos WHERE usuario_id = ? AND estado_corte = 0', [usuarioId]);
        const totalGastos = parseFloat(resGastos[0].total) || 0;

        const [resIngresos] = await connection.query('SELECT SUM(monto) as total FROM ingresos_extra WHERE usuario_id = ? AND estado_corte = 0', [usuarioId]);
        const totalIngresos = parseFloat(resIngresos[0].total) || 0;

        // D) LA FÓRMULA MATEMÁTICA MAESTRA
        const totalCajaFisica = saldoInicial + totalCobrado + totalIngresos - totalGastos;
        const entregado = parseFloat(montoEntregado) || 0;
        const retenido = totalCajaFisica - entregado; // Lo que se queda en el cajón

        // E) Creamos el registro Maestro del Corte con los nuevos campos
        const [insertCorte] = await connection.query(
            `INSERT INTO cortes_caja 
            (usuario_id, admin_autorizo_id, total_cobrado, total_gastos, total_entregado, saldo_inicial, total_ingresos_extra, monto_entregado, monto_retenido) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [usuarioId, adminId, totalCobrado, totalGastos, totalCajaFisica, saldoInicial, totalIngresos, entregado, retenido]
        );
        const corteId = insertCorte.insertId;

        // F) Aplicamos el candado a TODO (Pagos, Gastos e Ingresos Extra)
        // (Activos)
        await connection.query('UPDATE pagos SET estado_corte = 1, corte_id = ? WHERE usuario_id = ? AND estado_corte = 0', [corteId, usuarioId]);
        await connection.query('UPDATE gastos SET estado_corte = 1, corte_id = ? WHERE usuario_id = ? AND estado_corte = 0', [corteId, usuarioId]);
        await connection.query('UPDATE ingresos_extra SET estado_corte = 1, corte_id = ? WHERE usuario_id = ? AND estado_corte = 0', [corteId, usuarioId]);
        // (Cancelados)
        await connection.query('UPDATE pagos SET estado_corte = 4, corte_id = ? WHERE usuario_id = ? AND estado_corte = 3', [corteId, usuarioId]);
        await connection.query('UPDATE gastos SET estado_corte = 4, corte_id = ? WHERE usuario_id = ? AND estado_corte = 3', [corteId, usuarioId]);
        await connection.query('UPDATE ingresos_extra SET estado_corte = 4, corte_id = ? WHERE usuario_id = ? AND estado_corte = 3', [corteId, usuarioId]);

        // G) TRANSFERENCIA AUTOMÁTICA AL ADMINISTRADOR (Nivel ERP)
        if (entregado > 0) {
            // Obtenemos el nombre del cobrador para el concepto
            const [userRows] = await connection.query('SELECT nombre FROM usuarios WHERE id = ?', [usuarioId]);
            const nombreUser = userRows[0]?.nombre || 'Cobrador';
            
            // Inyectamos el dinero entregado directamente como un ingreso extra en tu cuenta de Admin
            await connection.query(
                'INSERT INTO ingresos_extra (usuario_id, descripcion, monto, estado_corte) VALUES (?, ?, ?, 0)',
                [adminId, `Recepción de corte de caja Folio #${corteId} (${nombreUser})`, entregado]
            );
        }

        // H) Confirmamos y cerramos Transacción
        await connection.commit();
        res.json({ success: true, message: "Corte procesado. Fondos transferidos con éxito.", corte_id: corteId });

    } catch (error) {
        await connection.rollback();
        console.error("Error crítico al procesar corte:", error);
        res.status(500).json({ error: error.message });
    } finally {
        connection.release();
    }
});

/* app.post('/api/procesar-corte', async (req, res) => {
    const { usuarioId, adminUser, adminPassword } = req.body;
    
    // Obtenemos una conexión dedicada exclusiva para esta Transacción
    const connection = await db.getConnection();

    try {
        // A) Validamos al administrador y obtenemos su ID
        const [admins] = await connection.query(
            'SELECT id FROM usuarios WHERE correo = ? AND password = ? AND rol_id = "2"', 
            [adminUser, adminPassword]
        );
        
        if (admins.length === 0) {
            connection.release();
            return res.status(401).json({ error: "Credenciales de administrador incorrectas." });
        }

        const adminId = admins[0].id;

        // B) INICIAMOS LA TRANSACCIÓN (Seguridad anti-fallos)
        await connection.beginTransaction();

        // C) Calculamos los totales EXACTOS de este turno ANTES de cerrarlo
        const [resPagos] = await connection.query(
            'SELECT SUM(monto) as total_cobrado FROM pagos WHERE usuario_id = ? AND estado_corte = 0',
            [usuarioId]
        );
        const totalCobrado = parseFloat(resPagos[0].total_cobrado) || 0;

        const [resGastos] = await connection.query(
            'SELECT SUM(monto) as total_gastos FROM gastos WHERE usuario_id = ? AND estado_corte = 0',
            [usuarioId]
        );
        const totalGastos = parseFloat(resGastos[0].total_gastos) || 0;

        const totalEntregado = totalCobrado - totalGastos;

        // D) Creamos el registro Maestro del Corte Histórico en la nueva tabla
        const [insertCorte] = await connection.query(
            `INSERT INTO cortes_caja (usuario_id, admin_autorizo_id, total_cobrado, total_gastos, total_entregado) 
             VALUES (?, ?, ?, ?, ?)`,
            [usuarioId, adminId, totalCobrado, totalGastos, totalEntregado]
        );
        
        // Obtenemos el ID del corte que se acaba de crear (Este es el CANDADO)
        const corteId = insertCorte.insertId;

        // E) Aplicamos el candado a los pagos y gastos cambiando su estado y asignando el corte_id
        
        // Pagos Activos
        await connection.query(
            'UPDATE pagos SET estado_corte = 1, corte_id = ? WHERE usuario_id = ? AND estado_corte = 0',
            [corteId, usuarioId]
        );
        // Pagos Cancelados
        await connection.query(
            'UPDATE pagos SET estado_corte = 4, corte_id = ? WHERE usuario_id = ? AND estado_corte = 3',
            [corteId, usuarioId]
        );

        // Gastos Activos
        await connection.query(
            'UPDATE gastos SET estado_corte = 1, corte_id = ? WHERE usuario_id = ? AND estado_corte = 0',
            [corteId, usuarioId]
        );
        // Gastos Cancelados
        await connection.query(
            'UPDATE gastos SET estado_corte = 4, corte_id = ? WHERE usuario_id = ? AND estado_corte = 3',
            [corteId, usuarioId]
        );

        // F) Si llegamos aquí sin errores, CONFIRMAMOS los cambios en la base de datos
        await connection.commit();
        
        res.json({ success: true, message: "Corte autorizado y guardado en el historial con éxito.", corte_id: corteId });

    } catch (error) {
        // Si hay cualquier error, REVERTIMOS TODOS los cambios
        await connection.rollback();
        console.error("Error crítico al procesar corte:", error);
        res.status(500).json({ error: error.message });
    } finally {
        // Siempre soltamos la conexión para no saturar el servidor
        connection.release();
    }
});
 */

// ==========================================
// RUTAS PARA EL HISTORIAL DE CORTES (PASO 3)
// ==========================================

// 1. Obtener la lista de cortes anteriores de un cobrador específico
app.get('/api/historico-cortes/:usuarioId', async (req, res) => {
    const { usuarioId } = req.params;
    try {
        const [cortes] = await db.query(
            `SELECT id, fecha_corte, total_cobrado, total_gastos, total_entregado 
             FROM cortes_caja 
             WHERE usuario_id = ? 
             ORDER BY id DESC`,
            [usuarioId]
        );
        res.json(cortes);
    } catch (error) {
        console.error("Error al obtener lista de histórico:", error);
        res.status(500).json({ error: error.message });
    }
});

// 2. La "Máquina del tiempo": Obtener los detalles exactos de un corte cerrado
/* app.get('/api/corte-caja-historico/:corteId', async (req, res) => {
    const { corteId } = req.params;
    try {
        // A) Rescatamos el resumen guardado en la bóveda
        const [resumenCorte] = await db.query(
            `SELECT total_cobrado as total_dinero, total_gastos, total_entregado as total_neto, fecha_corte 
             FROM cortes_caja WHERE id = ?`,
            [corteId]
        );

        if (resumenCorte.length === 0) {
            return res.status(404).json({ error: "Corte histórico no encontrado" });
        }

        // B) Buscamos los pagos amarrados a este candado (corte_id)
        const [detalles] = await db.query(
            `SELECT p.id, p.fecha_pago, c.nombre_completo as cliente, COALESCE(c.codigo_cliente, c.direccion_ip) as ip, p.mes_pagado, p.monto, p.estado_corte 
             FROM pagos p 
             JOIN clientes c ON p.cliente_id = c.id 
             WHERE p.corte_id = ? 
             ORDER BY p.id DESC`,
            [corteId]
        );

        // C) Buscamos los gastos amarrados a este candado (corte_id)
        const [gastos] = await db.query(
            `SELECT id, fecha_gasto, descripcion, monto, estado_corte
             FROM gastos
             WHERE corte_id = ?
             ORDER BY id DESC`,
            [corteId]
        );

        // Calculamos cuántos cobros activos (estado 1) hubo en este corte
        resumenCorte[0].total_cobros = detalles.filter(d => parseInt(d.estado_corte) === 1).length;

        // D) Respondemos con la MISMA estructura que usa tu Frontend actual
        res.json({ 
            resumen: resumenCorte[0], 
            detalles: detalles, 
            gastos: gastos 
        });
        
    } catch (error) {
        console.error("Error al obtener detalle histórico:", error);
        res.status(500).json({ error: error.message });
    }
}); */

// Ruta para obtener todas las localidades (para el selector del formulario)
app.get('/api/localidades', async (req, res) => {
    try {
        const [rows] = await db.query('SELECT id, nombre, color, codigo_localidad FROM localidades ORDER BY nombre ASC');
        res.json(rows);
    } catch (error) {
        console.error("Error al obtener localidades:", error);
        res.status(500).json({ error: "Error al cargar catálogo" });
    }
});



app.get('/api/paquetes', async (req, res) => {
    try {
        const [rows] = await db.query(
            `SELECT id, nombre_paquete, velocidad_mbps, velocidad_garantizada_mbps, costo
             FROM paquetes
             WHERE activo = 1
             ORDER BY costo ASC, velocidad_mbps ASC`
        );
        res.json(rows);
    } catch (error) {
        console.error("Error al obtener paquetes:", error);
        res.status(500).json({ error: "Error al cargar catalogo de paquetes" });
    }
});

app.get('/api/admin/paquetes', async (req, res) => {
    if (!validarAdministradorRequest(req, res)) return;

    try {
        const [rows] = await db.query(
            `SELECT id, nombre_paquete, velocidad_mbps, velocidad_garantizada_mbps, costo,
                    activo, fecha_creacion, fecha_actualizacion
             FROM paquetes
             ORDER BY activo DESC, costo ASC, velocidad_mbps ASC, nombre_paquete ASC`
        );
        res.json(rows);
    } catch (error) {
        console.error("Error al obtener paquetes administrativos:", error);
        res.status(500).json({ success: false, error: "Error al cargar catalogo administrativo de paquetes" });
    }
});

app.get('/api/admin/usuario-localidad', async (req, res) => {
    if (!validarAdministradorRequest(req, res)) return;

    try {
        const [usuarios] = await db.query(
            `SELECT
                u.id,
                u.nombre,
                u.correo,
                u.rol_id,
                COALESCE(GROUP_CONCAT(ul.localidad_id ORDER BY ul.localidad_id SEPARATOR ','), '') AS localidades
             FROM usuarios u
             LEFT JOIN usuario_localidad ul ON ul.usuario_id = u.id
             GROUP BY u.id, u.nombre, u.correo, u.rol_id
             ORDER BY u.rol_id ASC, u.nombre ASC`
        );

        const [localidades] = await db.query(
            `SELECT id, nombre, color, codigo_localidad
             FROM localidades
             ORDER BY nombre ASC`
        );

        res.json({
            success: true,
            usuarios: usuarios.map(usuario => ({
                ...usuario,
                localidades: String(usuario.localidades || '')
                    .split(',')
                    .filter(Boolean)
                    .map(id => parseInt(id, 10))
            })),
            localidades
        });
    } catch (error) {
        console.error("Error al obtener permisos de usuario-localidad:", error);
        res.status(500).json({ success: false, error: "Error al cargar permisos de usuario-localidad" });
    }
});

app.put('/api/admin/usuario-localidad/:usuarioId', async (req, res) => {
    if (!validarAdministradorRequest(req, res)) return;

    const usuarioId = parseInt(req.params.usuarioId, 10);
    const localidades = Array.isArray(req.body.localidades)
        ? [...new Set(req.body.localidades.map(id => parseInt(id, 10)).filter(Boolean))]
        : [];

    if (!usuarioId) {
        return res.status(400).json({ success: false, error: 'Usuario no valido.' });
    }

    let connection;
    try {
        connection = await db.getConnection();
        await connection.beginTransaction();

        const [usuarios] = await connection.query(
            'SELECT id FROM usuarios WHERE id = ? LIMIT 1',
            [usuarioId]
        );

        if (usuarios.length === 0) {
            await connection.rollback();
            return res.status(404).json({ success: false, error: 'Usuario no encontrado.' });
        }

        if (localidades.length > 0) {
            const [localidadesValidas] = await connection.query(
                'SELECT id FROM localidades WHERE id IN (?)',
                [localidades]
            );
            const idsValidos = new Set(localidadesValidas.map(loc => parseInt(loc.id, 10)));
            const hayLocalidadInvalida = localidades.some(id => !idsValidos.has(id));

            if (hayLocalidadInvalida) {
                await connection.rollback();
                return res.status(400).json({ success: false, error: 'Una o más localidades no son validas.' });
            }
        }

        await connection.query('DELETE FROM usuario_localidad WHERE usuario_id = ?', [usuarioId]);

        if (localidades.length > 0) {
            await connection.query(
                'INSERT INTO usuario_localidad (usuario_id, localidad_id) VALUES ?',
                [localidades.map(localidadId => [usuarioId, localidadId])]
            );
        }

        await connection.commit();
        res.json({ success: true, message: 'Permisos de localidades actualizados correctamente.' });
    } catch (error) {
        if (connection) {
            try {
                await connection.rollback();
            } catch (rollbackError) {
                console.error("Error al revertir permisos usuario-localidad:", rollbackError);
            }
        }

        console.error("Error al guardar permisos de usuario-localidad:", error);
        res.status(500).json({ success: false, error: "Error al guardar permisos: " + error.message });
    } finally {
        if (connection) connection.release();
    }
});

app.put('/api/admin/localidades/:id/color', async (req, res) => {
    if (!validarAdministradorRequest(req, res)) return;

    const localidadId = parseInt(req.params.id, 10);
    const color = String(req.body.color || '').trim();

    if (!localidadId) {
        return res.status(400).json({ success: false, error: 'Localidad no valida.' });
    }

    if (!/^#[0-9a-fA-F]{6}$/.test(color)) {
        return res.status(400).json({ success: false, error: 'El color debe tener formato hexadecimal, por ejemplo #3498db.' });
    }

    try {
        const [result] = await db.query(
            'UPDATE localidades SET color = ? WHERE id = ?',
            [color, localidadId]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, error: 'Localidad no encontrada.' });
        }

        res.json({ success: true, message: 'Color de localidad actualizado correctamente.' });
    } catch (error) {
        console.error("Error al actualizar color de localidad:", error);
        res.status(500).json({ success: false, error: "Error al actualizar color de localidad: " + error.message });
    }
});

app.post('/api/admin/paquetes', async (req, res) => {
    if (!validarAdministradorRequest(req, res)) return;

    const { datos, errores } = normalizarDatosPaquete(req.body);
    if (errores.length > 0) {
        return res.status(400).json({ success: false, error: errores.join(' ') });
    }

    try {
        const [result] = await db.query(
            `INSERT INTO paquetes
                (nombre_paquete, velocidad_mbps, velocidad_garantizada_mbps, costo, activo)
             VALUES (?, ?, ?, ?, ?)`,
            [
                datos.nombre_paquete,
                datos.velocidad_mbps,
                datos.velocidad_garantizada_mbps,
                datos.costo,
                datos.activo
            ]
        );

        res.json({
            success: true,
            message: 'Paquete creado correctamente.',
            id: result.insertId
        });
    } catch (error) {
        console.error("Error al crear paquete:", error);
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ success: false, error: 'Ya existe un paquete con ese nombre.' });
        }
        res.status(500).json({ success: false, error: "Error al crear paquete: " + error.message });
    }
});

app.put('/api/admin/paquetes/:id', async (req, res) => {
    if (!validarAdministradorRequest(req, res)) return;

    const paqueteId = parseInt(req.params.id, 10);
    if (!paqueteId) {
        return res.status(400).json({ success: false, error: 'Paquete no valido.' });
    }

    const { datos, errores } = normalizarDatosPaquete(req.body);
    if (errores.length > 0) {
        return res.status(400).json({ success: false, error: errores.join(' ') });
    }

    try {
        const [result] = await db.query(
            `UPDATE paquetes
             SET nombre_paquete = ?,
                 velocidad_mbps = ?,
                 velocidad_garantizada_mbps = ?,
                 costo = ?,
                 activo = ?
             WHERE id = ?`,
            [
                datos.nombre_paquete,
                datos.velocidad_mbps,
                datos.velocidad_garantizada_mbps,
                datos.costo,
                datos.activo,
                paqueteId
            ]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, error: 'Paquete no encontrado.' });
        }

        res.json({ success: true, message: 'Paquete actualizado correctamente.' });
    } catch (error) {
        console.error("Error al actualizar paquete:", error);
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ success: false, error: 'Ya existe un paquete con ese nombre.' });
        }
        res.status(500).json({ success: false, error: "Error al actualizar paquete: " + error.message });
    }
});

app.post('/api/cancelar-pago/:id', async (req, res) => {
    const idPago = req.params.id;
    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();

        const [pagos] = await connection.query(
            'SELECT id FROM pagos WHERE id = ? AND estado_corte = 0 FOR UPDATE',
            [idPago]
        );

        if (pagos.length === 0) {
            await connection.rollback();
            return res.status(404).json({
                success: false,
                message: 'No se encontro el pago pendiente especificado.'
            });
        }

        const [ajustes] = await connection.query(
            `SELECT COALESCE(SUM(monto_aplicado), 0) AS monto_liberado,
                    COUNT(*) AS total_ajustes
             FROM aplicaciones_ajustes_servicio
             WHERE pago_id = ?`,
            [idPago]
        );

        const montoLiberado = parseFloat(ajustes[0]?.monto_liberado) || 0;
        const totalAjustes = parseInt(ajustes[0]?.total_ajustes) || 0;

        if (totalAjustes > 0) {
            await connection.query(
                'DELETE FROM aplicaciones_ajustes_servicio WHERE pago_id = ?',
                [idPago]
            );
        }

        const [result] = await connection.query(
            'UPDATE pagos SET estado_corte = 3 WHERE id = ? AND estado_corte = 0',
            [idPago]
        );

        if (result.affectedRows === 0) {
            await connection.rollback();
            return res.status(404).json({
                success: false,
                message: 'No se encontro el pago pendiente especificado.'
            });
        }

        await connection.commit();

        res.json({
            success: true,
            message: 'Pago cancelado correctamente.',
            monto_ajuste_liberado: montoLiberado
        });
    } catch (error) {
        await connection.rollback();
        console.error('Error en el servidor al cancelar pago:', error);
        res.status(500).json({
            success: false,
            message: 'Error interno del servidor al procesar la solicitud.'
        });
    } finally {
        connection.release();
    }
});
// Ruta para actualizar el teléfono de un cliente
app.put('/api/clientes/:id/telefono', async (req, res) => {
    // 1. Obtenemos el ID del cliente desde la URL
    const idCliente = req.params.id;
    // 2. Obtenemos el nuevo teléfono desde el cuerpo de la petición (body)
    const { nuevoTelefono } = req.body;

    try {
        // 3. Preparamos la consulta SQL para actualizar solo el campo del teléfono
        // Nota: Asegúrate de que el campo en tu base de datos se llame 'telefono'
        const query = 'UPDATE clientes SET telefono = ? WHERE id = ?';
        
        // 4. Ejecutamos la consulta en la base de datos
        await db.execute(query, [nuevoTelefono, idCliente]);

        // 5. Respondemos al navegador que todo salió bien
        res.json({ success: true, message: 'Teléfono actualizado correctamente' });

    } catch (error) {
        console.error('Error al actualizar el teléfono:', error);
        res.status(500).json({ error: 'Error interno del servidor al actualizar el teléfono' });
    }
});

// Ruta para actualizar el Alias de un cliente
app.put('/api/clientes/:id/alias', async (req, res) => {
    // 1. Obtenemos el ID del cliente desde la URL
    const idCliente = req.params.id;
    // 2. Obtenemos el nuevo teléfono desde el cuerpo de la petición (body)
    const { nuevoAlias } = req.body;

    try {
        // 3. Preparamos la consulta SQL para actualizar solo el campo del teléfono
        // Nota: Asegúrate de que el campo en tu base de datos se llame 'telefono'
        const query = 'UPDATE clientes SET alias_cliente = ? WHERE id = ?';
        
        // 4. Ejecutamos la consulta en la base de datos
        await db.execute(query, [nuevoAlias, idCliente]);

        // 5. Respondemos al navegador que todo salió bien
        res.json({ success: true, message: 'Alias actualizado correctamente' });

    } catch (error) {
        console.error('Error al actualizar el teléfono:', error);
        res.status(500).json({ error: 'Error interno del servidor al actualizar el teléfono' });
    }
});

/* // Ruta para obtener el resumen de cobradores (Supervisión Admin)
app.get('/api/admin/supervision-cortes/:adminId', async (req, res) => {
    const adminId = req.params.adminId;
    try {
        const query = `
            SELECT u.id as cobrador_id, u.nombre as cobrador_nombre, 
                   COUNT(p.id) as total_cobros, SUM(p.monto) as total_recaudado
            FROM pagos p
            JOIN usuarios u ON p.usuario_id = u.id
            WHERE p.estado_corte = 0 AND u.id != ?
            GROUP BY u.id
            ORDER BY total_recaudado DESC
        `;
        const [cobradores] = await db.execute(query, [adminId]);
        res.json(cobradores);
    } catch (error) {
        console.error("Error en supervisión de cortes:", error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
}); */

// Ruta para obtener el resumen de cobradores (Supervisión Admin)
app.get('/api/admin/supervision-cortes/:adminId', async (req, res) => {
    const adminId = req.params.adminId;
    try {
        // Hacemos que la tabla principal sea 'usuarios' y usamos subconsultas 
        // para que traiga a todos, aunque los montos de sus tablas sean 0.
        const query = `
            SELECT 
                u.id AS cobrador_id, 
                u.nombre AS cobrador_nombre,
                
                IFNULL((SELECT COUNT(id) FROM pagos WHERE usuario_id = u.id AND estado_corte = 0), 0) AS total_cobros,
                IFNULL((SELECT SUM(monto) FROM pagos WHERE usuario_id = u.id AND estado_corte = 0), 0) AS total_recaudado,
                IFNULL((SELECT SUM(monto) FROM ingresos_extra WHERE usuario_id = u.id AND estado_corte = 0), 0) AS total_ingresos_extra,
                IFNULL((SELECT SUM(monto) FROM gastos WHERE usuario_id = u.id AND estado_corte = 0), 0) AS total_gastos,
                
                -- Obtenemos el saldo inicial del último corte aprobado (estado = 1)
                IFNULL((SELECT monto_retenido FROM cortes_caja WHERE usuario_id = u.id ORDER BY id DESC LIMIT 1), 0) AS saldo_inicial
            
            FROM usuarios u
            WHERE u.id != ? 
            -- NOTA: Si en la tabla 'usuarios' también guardas a los clientes, descomenta la siguiente línea 
            -- para filtrar solo a los que tienen rol de cobrador/staff (ej. roles 1, 2, 3)
            -- AND u.rol_id IN (1, 2, 3)
            
            ORDER BY total_recaudado DESC
        `;
        
        const [cobradores] = await db.execute(query, [adminId]);

        // Procesamos los datos antes de enviarlos para asegurar que sean números 
        // y calcular la Caja Física total de una vez.
        const resultadosFormateados = cobradores.map(c => {
            const saldoInicial = parseFloat(c.saldo_inicial);
            const totalRecaudado = parseFloat(c.total_recaudado); // Mensualidades
            const ingresosExtra = parseFloat(c.total_ingresos_extra);
            const gastos = parseFloat(c.total_gastos);
            
            // Matemáticas de la caja física: (Fondo + Mensualidades + Extra) - Gastos
            const cajaFisica = (saldoInicial + totalRecaudado + ingresosExtra) - gastos;

            return {
                cobrador_id: c.cobrador_id,
                cobrador_nombre: c.cobrador_nombre,
                total_cobros: parseInt(c.total_cobros),
                saldo_inicial: saldoInicial,
                total_recaudado: totalRecaudado,
                total_ingresos_extra: ingresosExtra,
                total_gastos: gastos,
                caja_fisica: cajaFisica
            };
        });

        res.json(resultadosFormateados);
    } catch (error) {
        console.error("Error en supervisión de cortes:", error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// ==========================================
// MÓDULO DE CAJA CHICA: INGRESOS EXTRA
// ==========================================

// Registrar un ingreso extra
app.post('/api/ingreso-extra', async (req, res) => {
    const { usuarioId, descripcion, monto } = req.body;
    try {
        await db.query(
            'INSERT INTO ingresos_extra (usuario_id, descripcion, monto) VALUES (?, ?, ?)',
            [usuarioId, descripcion, monto]
        );
        res.json({ success: true, message: "Ingreso extra registrado correctamente" });
    } catch (error) {
        console.error("Error al registrar ingreso extra:", error);
        res.status(500).json({ error: error.message });
    }
});

// Cancelar un ingreso extra (estado 3)
app.post('/api/cancelar-ingreso-extra/:id', async (req, res) => {
    const idIngreso = req.params.id;
    try {
        await db.query('UPDATE ingresos_extra SET estado_corte = 3 WHERE id = ?', [idIngreso]);
        res.json({ success: true, message: "Ingreso extra cancelado" });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

