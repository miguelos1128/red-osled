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

        // 1. OBTENER DATOS DEL USUARIO DESDE LA URL (req.query)
        // El frontend nos enviará algo como: ?rol=3&localidades=1,2
        const rol = parseInt(req.query.rol);
        
        // Convertimos el texto "1,2" en un arreglo real de números: [1, 2]
        let localidadesArray = [];
        if (req.query.localidades) {
            localidadesArray = req.query.localidades.split(',').map(Number);
        }

        // 2. CONSTRUIR LA CONSULTA SQL BASE
        // (Dejamos un espacio antes del GROUP BY para poder insertar el WHERE si es necesario)
        let query = `
            SELECT 
                c.id, c.nombre_completo, c.telefono, c.es_renta, c.estado_servicio, bs.tipo_evento AS tipo_suspension_activa,
                fecha_instalacion, c.direccion_ip, c.costo_mensual, c.dia_pago, c.localidad_id,
                IFNULL(GROUP_CONCAT(CONCAT(p.mes_pagado, ':', p.estado_corte) SEPARATOR ','), '') as historial_pagos
            FROM clientes c
            LEFT JOIN bitacora_servicio bs ON bs.cliente_id = c.id
                AND bs.estado = 'Activo'
            LEFT JOIN pagos p ON c.id = p.cliente_id 
                AND YEAR(p.fecha_pago) = YEAR(CURRENT_DATE())
        `;

        // Arreglo para guardar los valores que reemplazaremos en los signos de interrogación (?)
        let queryParams = [];

        // 3. APLICAR EL FILTRO DE LOCALIDADES (LA LÓGICA DE ROLES)
        // Si es rol 3 (Supervisor) o rol 1 (Recepcionista) y tiene localidades asignadas:
        if ((rol === 3 || rol === 1) && localidadesArray.length > 0) {
            // Creamos los signos de interrogación dinámicamente. Ej: "?, ?, ?"
            const placeholders = localidadesArray.map(() => '?').join(',');
            
            // Agregamos la condición a la consulta
            query += ` WHERE c.localidad_id IN (${placeholders}) `;
            
            // Guardamos los números de las localidades para que la base de datos los procese de forma segura
            queryParams = [...localidadesArray]; 
        }

        // 4. CERRAR LA CONSULTA
        // Agregamos la agrupación y el orden sin importar si filtramos o no
        query += `
            GROUP BY c.id, c.nombre_completo, c.telefono, c.es_renta, c.estado_servicio, bs.tipo_evento,
                c.direccion_ip, c.costo_mensual, c.dia_pago, c.localidad_id
            ORDER BY c.dia_pago;
        `;

        // 5. EJECUTAR LA CONSULTA
        // Pasamos el query y los parámetros de forma segura
        const [clientes] = await db.query(query, queryParams);
        res.json(clientes);

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
            console.log('Usuario no encontrado');
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

// Ruta para agregar un nuevo cliente (POST)
// Ruta actualizada para agregar un nuevo cliente
app.post('/api/clientes', async (req, res) => {
    try{
        // 1. Obtenemos los datos del cuerpo de la petición (req.body)
        const { 
            nombre_completo, telefono, correo, direccion, observaciones, es_renta,
            fecha_instalacion, dia_pago, direccion_ip, señal, paquete, costo_mensual, localidad_id, rol_usuario
        } = req.body;

        // 2. VALIDACIÓN DE SEGURIDAD (Bloqueo de Creación)
        // Comprobamos si el usuario NO es el Administrador (rol 2)
        if (rol_usuario !== 2) {
            // Detenemos la ejecución y enviamos un mensaje de error al navegador
            return res.status(403).json({
                success: false,
                mensaje: "Acceso denegado: Tu rol no tiene permisos para crear clientes."
            });
        }

        const query = `INSERT INTO clientes 
                    (nombre_completo, telefono, correo, direccion, observaciones, es_renta, fecha_instalacion, dia_pago, direccion_ip, señal, paquete, costo_mensual, localidad_id) 
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        console.log("Query", query);
        console.log("Datos recibidos para el nuevo cliente:", req.body);
    // 2. Abrimos el bloque try/catch
    
        // 3. Usamos 'await' y extraemos [result] (Borramos el callback)
        const [result] = await db.query(query, [
        nombre_completo, telefono, correo, direccion, observaciones || null, es_renta ? 1 : 0,
        fecha_instalacion, dia_pago, direccion_ip, señal, paquete, costo_mensual,localidad_id
        ]);
        // 4a. Si todo sale bien, respondemos aquí
        res.json({ success: true, mensaje: "Cliente creado con éxito" });
    }catch(error){
        // 4b. Si hay un error, el 'catch' lo atrapa automáticamente
        console.error("Error al crear cliente:", err);
        res.status(500).json({ error: "Error al guardar en la BD: " + error.message });
    }
});

// Ruta para buscar clientes por nombre o IP
// 1. Agregamos async aquí
app.get('/api/buscar-clientes', async (req, res) => {
    try {
        const term = req.query.q; // Lo que el cliente escribe
        // 1. Recibimos el "gafete" del frontend desde la URL
        const rol = parseInt(req.query.rol);
        // Convertimos el texto "[1,3]" de vuelta a un arreglo real de Javascript [1, 3]
        let localidadesPermitidas = [];
        if (req.query.localidades) {
            localidadesPermitidas = JSON.parse(req.query.localidades);
        }
        
        // 2. Preparamos la consulta base
        let query = `
            SELECT id, nombre_completo, telefono, direccion_ip, costo_mensual, fecha_instalacion, dia_pago 
            FROM clientes  WHERE  (nombre_completo LIKE ? OR direccion_ip LIKE ? )
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

        query += ` LIMIT 10`;

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

/* // RUTA 1: Consultar el último pago de un cliente
app.get('/api/ultimo-pago/:id', async (req, res) => {
    const { id } = req.params;
    const query = `
        SELECT mes_pagado, fecha_pago, monto,  tipo_pago
        FROM pagos 
        WHERE cliente_id = ? and estado_corte < 3
        ORDER BY fecha_pago DESC LIMIT 1`;
    try{
        const [result] = await db.query(query, [id]);
        // Si hay resultados, mandamos el primero, si no, mandamos null
        res.json(result.length > 0 ? result[0] : null);
    }catch(err){
        console.error("Error en DB:", err);
            return res.status(500).json({ error: "Error al consultar historial" });
    }
});
 */
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

    try {
        const [cliente] = await db.query('SELECT costo_mensual, fecha_instalacion, dia_pago FROM clientes WHERE id = ?', [clienteId]);
        if (!cliente.length) return res.status(404).json({ error: "Cliente no encontrado" });
        const clienteData = cliente[0];
        const costoMensual = parseFloat(clienteData.costo_mensual) || 0;
        let saldoRestante = parseFloat(montoRecibido);

        if (!saldoRestante || saldoRestante <= 0) {
            return res.status(400).json({ error: "Monto inválido" });
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
        const estadoCuenta = calcularEstadoCuentaServidor(clienteData, pagosExistentes, bitacora);
        let ajustePendienteDisponible = parseFloat(estadoCuenta.monto_ajustes_pendientes) || 0;
        const registros = [];
        const aplicarPagoMes = async (etiquetaMes, pendienteMes, ajusteAAplicar = 0) => {
            const pagadoAntes = historial[etiquetaMes] || 0;
            const montoAAplicar = Math.min(saldoRestante, pendienteMes);
            let nuevoTipo = (montoAAplicar >= pendienteMes && pagadoAntes === 0) ? 'completo' : 'abono';

            if (pagadoAntes + montoAAplicar + ajusteAAplicar >= costoMensual) nuevoTipo = 'completo';

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

        for (const mesAdeudado of estadoCuenta.meses_adeudados) {
            if (saldoRestante <= 0) break;
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
                ajusteAAplicar
            );
        }

        const fechaInstalacion = new Date(clienteData.fecha_instalacion);
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
            const etiquetaMes = obtenerEtiquetaMes(cursor.anio, cursor.mesIndex);
            const pagadoEnEsteMes = historial[etiquetaMes] || 0;
            const ajusteAAplicar = Math.min(ajustePendienteDisponible, Math.max(costoMensual - pagadoEnEsteMes, 0));
            const pendienteMes = Math.max(costoMensual - pagadoEnEsteMes - ajusteAAplicar, 0);

            if (pendienteMes <= 0 && ajusteAAplicar > 0) {
                const ajusteAplicado = await aplicarAjustesPendientes(connection, clienteId, etiquetaMes, ajusteAAplicar);
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
                await aplicarPagoMes(etiquetaMes, pendienteMes, ajusteAAplicar);
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
    return ['falla_tecnica', 'decision_usuario'].includes(evento.tipo_evento)
        && evento.estado === 'Finalizado'
        && (parseFloat(evento.monto_ajuste) || 0) > 0;
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

async function aplicarAjustesPendientes(ejecutor, clienteId, mesAplicado, montoAAplicar, pagoId = null) {
    let restante = Number((parseFloat(montoAAplicar) || 0).toFixed(2));
    if (restante <= 0) return 0;

    const [eventos] = await ejecutor.query(
        `SELECT b.id, b.monto_ajuste,
            COALESCE(SUM(a.monto_aplicado), 0) AS monto_aplicado
         FROM bitacora_servicio b
         LEFT JOIN aplicaciones_ajustes_servicio a ON a.bitacora_id = b.id
         WHERE b.cliente_id = ?
           AND b.tipo_evento IN ('falla_tecnica', 'decision_usuario')
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

    return {
        eventos,
        suspension_activa: suspensionActiva,
        dias_compensados: diasCompensadosFinalizados + diasCongeladosActivos,
        dias_congelados_activos: diasCongeladosActivos,
        dias_compensados_efectivos: 0,
        monto_ajustes: ajustes.pendiente,
        ajustes
    };
}

function mesEstaVencido(anio, mesIndex, diaPago, hoy = new Date(), diasCompensados = 0) {
    const comparacionMes = compararMesContable(anio, mesIndex, hoy.getFullYear(), hoy.getMonth());

    if (comparacionMes < 0) return true;
    if (comparacionMes > 0) return false;

    return hoy >= obtenerFechaVencimiento(anio, mesIndex, diaPago, diasCompensados);
}

function calcularEstadoCuentaServidor(cliente, pagos, bitacora = []) {
    const costoMensual = parseFloat(cliente.costo_mensual) || 0;
    const fechaInstalacion = new Date(cliente.fecha_instalacion);
    const diaPago = parseInt(cliente.dia_pago) || fechaInstalacion.getDate() || 1;
    const totalPagado = pagos.reduce((total, pago) => total + (parseFloat(pago.monto) || 0), 0);
    const resumenServicio = resumirBitacoraServicio(bitacora);
    const ajustesServicio = resumenServicio.ajustes;
    let saldoAjustePendiente = ajustesServicio.pendiente;
    const pagosPorMes = {};

    pagos.forEach(pago => {
        const mes = pago.mes_pagado;
        pagosPorMes[mes] = (pagosPorMes[mes] || 0) + (parseFloat(pago.monto) || 0);
    });

    const mesesAdeudados = [];
    const mesesVencidos = [];
    let fechaProximoPago = null;
    let cursor = avanzarMesContable(fechaInstalacion.getFullYear(), fechaInstalacion.getMonth(), 1);
    const hoy = new Date();

    while (compararMesContable(cursor.anio, cursor.mesIndex, hoy.getFullYear(), hoy.getMonth()) <= 0) {
        if (mesEstaVencido(cursor.anio, cursor.mesIndex, diaPago, hoy, 0)) {
            const etiquetaMes = obtenerEtiquetaMes(cursor.anio, cursor.mesIndex);
            const pagadoEnMes = pagosPorMes[etiquetaMes] || 0;
            const ajusteAplicadoEnMes = ajustesServicio.aplicado_por_mes[etiquetaMes] || 0;
            const pendienteSinAjuste = Math.max(costoMensual - pagadoEnMes - ajusteAplicadoEnMes, 0);
            const ajustePendienteAplicable = Number(Math.min(saldoAjustePendiente, pendienteSinAjuste).toFixed(2));
            const pendiente = Number(Math.max(pendienteSinAjuste - ajustePendienteAplicable, 0).toFixed(2));

            mesesVencidos.push(etiquetaMes);
            saldoAjustePendiente = Number(Math.max(saldoAjustePendiente - ajustePendienteAplicable, 0).toFixed(2));

            if (pendienteSinAjuste > 0) {
                mesesAdeudados.push({
                    mes: etiquetaMes,
                    monto_esperado: costoMensual,
                    monto_cubierto: Math.min(pagadoEnMes + ajusteAplicadoEnMes, costoMensual),
                    monto_ajuste_aplicado: ajusteAplicadoEnMes,
                    monto_ajuste_pendiente: ajustePendienteAplicable,
                    pendiente_sin_ajuste: Number(pendienteSinAjuste.toFixed(2)),
                    pendiente: pendiente
                });
            }
        } else if (!fechaProximoPago) {
            fechaProximoPago = obtenerFechaVencimiento(cursor.anio, cursor.mesIndex, diaPago, 0);
        }

        cursor = avanzarMesContable(cursor.anio, cursor.mesIndex, 1);
    }

    if (!fechaProximoPago) {
        fechaProximoPago = obtenerFechaVencimiento(cursor.anio, cursor.mesIndex, diaPago, 0);
    }

    const mesesTranscurridos = mesesVencidos.length;
    const montoAjustes = resumenServicio.monto_ajustes;
    const totalTeorico = Math.max((mesesTranscurridos * costoMensual) - ajustesServicio.total_aplicado, 0);
    const adeudoMensual = mesesAdeudados.reduce((total, mes) => total + mes.pendiente, 0);
    const adeudoActual = adeudoMensual;
    const saldoFavor = Number((Math.max(totalPagado - totalTeorico, 0) + saldoAjustePendiente).toFixed(2));
    const mesesAdeudoDecimal = costoMensual > 0 ? adeudoActual / costoMensual : 0;

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
            `SELECT c.*, l.nombre AS localidad_nombre
             FROM clientes c
             LEFT JOIN localidades l ON c.localidad_id = l.id
             WHERE c.id = ?`,
            [clienteId]
        );

        if (clienteRows.length === 0) {
            return res.status(404).json({ error: 'Cliente no encontrado' });
        }

        const [pagos] = await db.query(
            `SELECT p.*, u.nombre AS cobrador_nombre
             FROM pagos p
             LEFT JOIN usuarios u ON p.usuario_id = u.id
             WHERE p.cliente_id = ? AND p.estado_corte < 3
             ORDER BY p.id DESC`,
            [clienteId]
        );

        const bitacora = await consultarBitacoraServicio(db, clienteId);

        const estadoCuenta = calcularEstadoCuentaServidor(clienteRows[0], pagos, bitacora);

        res.json({
            cliente: clienteRows[0],
            historial_pagos: pagos,
            bitacora_servicio: bitacora,
            estado_cuenta: estadoCuenta
        });
    } catch (error) {
        console.error('Error al calcular estado de cuenta completo:', error);
        res.status(500).json({ error: 'Error al calcular estado de cuenta del cliente' });
    }
});

app.post('/api/clientes/:id/suspender-servicio', async (req, res) => {
    const clienteId = req.params.id;
    const { tipo_evento, dias_compensados, fecha_inicio, fecha_fin, observaciones } = req.body;
    const tiposValidos = ['falta_pago', 'decision_usuario', 'falla_tecnica'];

    try {
        await finalizarAusenciasProgramadasVencidas(db, clienteId);

        if (!tiposValidos.includes(tipo_evento)) {
            return res.status(400).json({ success: false, error: 'Tipo de suspensión no válido.' });
        }

        const [activos] = await db.query(
            'SELECT id FROM bitacora_servicio WHERE cliente_id = ? AND estado = "Activo" LIMIT 1',
            [clienteId]
        );

        if (activos.length > 0 && tipo_evento !== 'falla_tecnica') {
            return res.status(400).json({ success: false, error: 'El cliente ya tiene una suspensión activa.' });
        }

        if (tipo_evento === 'falla_tecnica') {
            const dias = parseInt(dias_compensados) || 0;
            const observacionesLimpias = (observaciones || '').trim();

            if (!fecha_inicio || !fecha_fin) {
                return res.status(400).json({ success: false, error: 'Captura fecha inicio y fecha fin de la falla tecnica.' });
            }

            if (dias <= 0) {
                return res.status(400).json({ success: false, error: 'Indica los días compensados de la falla técnica.' });
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
            const estadoCuenta = calcularEstadoCuentaServidor(
                {
                    costo_mensual: clienteRows[0].costo_mensual,
                    fecha_instalacion: clienteRows[0].fecha_instalacion,
                    dia_pago: clienteRows[0].dia_pago
                },
                pagos,
                bitacora
            );

            if ((parseFloat(estadoCuenta.adeudo_actual) || 0) > 0) {
                return res.status(400).json({
                    success: false,
                    error: 'Solo se puede registrar ausencia del cliente cuando está al corriente.'
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

        await db.query(
            `INSERT INTO bitacora_servicio
                (cliente_id, tipo_evento, fecha_inicio, fecha_fin, dias_compensados, monto_ajuste, estado)
             VALUES (?, ?, NOW(), NULL, 0, 0.00, 'Activo')`,
            [clienteId, tipo_evento]
        );

        await db.query(
            'UPDATE clientes SET estado_servicio = ? WHERE id = ?',
            ['Suspendido', clienteId]
        );

        res.json({ success: true, message: 'Servicio suspendido correctamente.' });
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
            return res.status(404).json({ success: false, error: 'No hay suspensión activa para este cliente.' });
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
            dias_compensados: diasCompensados,
            monto_ajuste: montoAjuste
        });
    } catch (error) {
        console.error('Error al reactivar servicio:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/clientes/:id/reactivar-con-pago', async (req, res) => {
    const clienteId = req.params.id;
    const { usuarioId, montoRecibido } = req.body;
    const connection = await db.getConnection();

    try {
        const montoTotalRecibido = parseFloat(montoRecibido);

        if (!montoTotalRecibido || montoTotalRecibido <= 0) {
            return res.status(400).json({ success: false, error: 'Monto inválido.' });
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
            return res.status(400).json({ success: false, error: 'No hay suspensión activa por falta de pago.' });
        }

        const [pagosExistentes] = await connection.query(
            'SELECT mes_pagado, monto FROM pagos WHERE cliente_id = ? AND estado_corte < 3',
            [clienteId]
        );

        const bitacora = await consultarBitacoraServicio(connection, clienteId);

        const clienteData = clienteRows[0];
        const costoMensual = parseFloat(clienteData.costo_mensual) || 0;
        const estadoCuenta = calcularEstadoCuentaServidor(clienteData, pagosExistentes, bitacora);
        const adeudoMensual = parseFloat(estadoCuenta.adeudo_mensual) || 0;
        const minimoReactivacion = adeudoMensual;

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
        const aplicarPagoMes = async (etiquetaMes, pendienteMes, ajusteAAplicar = 0) => {
            const pagadoAntes = historial[etiquetaMes] || 0;
            const montoAAplicar = Math.min(saldoRestante, pendienteMes);
            let nuevoTipo = (montoAAplicar >= pendienteMes && pagadoAntes === 0) ? 'completo' : 'abono';

            if (pagadoAntes + montoAAplicar + ajusteAAplicar >= costoMensual) nuevoTipo = 'completo';

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

        for (const mesAdeudado of estadoCuenta.meses_adeudados) {
            if (saldoRestante <= 0) break;
            const ajusteAAplicar = Math.min(ajustePendienteDisponible, parseFloat(mesAdeudado.monto_ajuste_pendiente) || 0);

            if ((parseFloat(mesAdeudado.pendiente) || 0) <= 0 && ajusteAAplicar > 0) {
                const ajusteAplicado = await aplicarAjustesPendientes(db, clienteId, mesAdeudado.mes, ajusteAAplicar);
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
                ajusteAAplicar
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
            const fechaInstalacion = new Date(clienteData.fecha_instalacion);
            cursor = avanzarMesContable(fechaInstalacion.getFullYear(), fechaInstalacion.getMonth(), 1);
        }

        const anioLimite = new Date().getFullYear() + 2;

        while (saldoRestante > 0 && cursor.anio <= anioLimite) {
            const etiquetaMes = obtenerEtiquetaMes(cursor.anio, cursor.mesIndex);
            const pagadoEnEsteMes = historial[etiquetaMes] || 0;
            const ajusteAAplicar = Math.min(ajustePendienteDisponible, Math.max(costoMensual - pagadoEnEsteMes, 0));
            const pendienteMes = Math.max(costoMensual - pagadoEnEsteMes - ajusteAAplicar, 0);

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
                await aplicarPagoMes(etiquetaMes, pendienteMes, ajusteAAplicar);
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

// 1. Ruta para obtener el total y la lista de pagos sin entregar (estado_corte = 0)
app.get('/api/corte-caja/:usuarioId', async (req, res) => {
    const { usuarioId } = req.params;
    try {
        const [resumen] = await db.query(
            'SELECT COUNT(id) as total_cobros, SUM(monto) as total_dinero FROM pagos WHERE usuario_id = ? AND estado_corte = 0',
            [usuarioId]
        );
        const [detalles] = await db.query(
            `SELECT p.id, p.fecha_pago, c.nombre_completo as cliente, c.direccion_ip as ip, p.mes_pagado, p.monto, p.estado_corte 
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

        const [usuarios] = await db.query(
            'SELECT rol_id FROM usuarios WHERE id = ? AND rol_id IN (2, 3)',
            [usuarioId]
        );

        if (usuarios.length === 0) {
            return res.status(403).json({ success: false, error: 'Tu rol no tiene permisos para registrar gastos.' });
        }

        const [resumenCaja] = await db.query(
            `SELECT
                IFNULL((SELECT SUM(monto) FROM pagos WHERE usuario_id = ? AND estado_corte = 0), 0) AS total_pagos,
                IFNULL((SELECT SUM(monto) FROM gastos WHERE usuario_id = ? AND estado_corte = 0), 0) AS total_gastos`,
            [usuarioId, usuarioId]
        );

        const efectivoDisponible = (parseFloat(resumenCaja[0].total_pagos) || 0) - (parseFloat(resumenCaja[0].total_gastos) || 0);

        if (efectivoDisponible <= 0) {
            return res.status(400).json({ success: false, error: 'No hay efectivo disponible para registrar gastos.' });
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
    const { usuarioId, adminUser, adminPassword } = req.body;
    try {
        // A) Validamos al administrador (Ajusta 'usuarios' según el nombre real de tu tabla de login)
        const [admins] = await db.query(
            'SELECT id FROM usuarios WHERE correo = ? AND password = ? AND rol_id = "2"', 
            [adminUser, adminPassword]
        );
        
        if (admins.length === 0) {
            return res.status(401).json({ error: "Credenciales de administrador incorrectas." });
        }

        // B) Si el admin es correcto, cambiamos el estado de 0 a 1 y de 3 a 4
        await db.query(
            'UPDATE pagos SET estado_corte = 1 WHERE usuario_id = ? AND estado_corte = 0',
            [usuarioId]
        );

        await db.query(
            'UPDATE pagos SET estado_corte = 4 WHERE usuario_id = ? AND estado_corte = 3',
            [usuarioId]
        );

        await db.query(
            'UPDATE gastos SET estado_corte = 1 WHERE usuario_id = ? AND estado_corte = 0',
            [usuarioId]
        );

        await db.query(
            'UPDATE gastos SET estado_corte = 4 WHERE usuario_id = ? AND estado_corte = 3',
            [usuarioId]
        );
        
        res.json({ success: true, message: "Corte autorizado y procesado con éxito." });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Ruta para obtener todas las localidades (para el selector del formulario)
app.get('/api/localidades', async (req, res) => {
    try {
        const [rows] = await db.query('SELECT id, nombre, color FROM localidades ORDER BY nombre ASC');
        res.json(rows);
    } catch (error) {
        console.error("Error al obtener localidades:", error);
        res.status(500).json({ error: "Error al cargar catálogo" });
    }
});



app.post('/api/cancelar-pago/:id', async (req, res) => {
    const idPago = req.params.id;

    try {
        // 1. Preparamos la consulta SQL
        // IMPORTANTE: Verifica que los nombres de tu tabla ('pagos') 
        // y tus columnas ('id_estado', 'id_pago') coincidan con tu base de datos real.
        const query = `UPDATE pagos SET estado_corte = 3 WHERE id = ?`;
        console.log('Query '+ query+ 'id: '+ idPago )
        
        // 2. Ejecutamos la consulta (Ejemplo usando un 'pool' de mysql2 con promesas)
        const [result] = await db.query(query, [idPago]);

        // 3. Verificamos si realmente se modificó algún registro
        if (result.affectedRows > 0) {
            res.json({ 
                success: true, 
                message: 'Pago cancelado correctamente.' 
            });
        } else {
            // Si affectedRows es 0, significa que el ID no existe
            res.status(404).json({ 
                success: false, 
                message: 'No se encontró el pago especificado.' 
            });
        }

    } catch (error) {
        console.error('Error en el servidor al cancelar pago:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Error interno del servidor al procesar la solicitud.' 
        });
    }
});
/* 
// RUTA PARA OBTENER EL PERFIL COMPLETO DEL CLIENTE (VERSIÓN CON PROMESAS)
app.get('/cliente-completo/:id', async (req, res) => {
    const idCliente = req.params.id;

    try {
        // Consulta 1: Datos del cliente + Nombre de la localidad
        const queryCliente = `
            SELECT c.*, l.nombre AS localidad_nombre 
            FROM clientes c 
            LEFT JOIN localidades l ON c.localidad_id = l.id 
            WHERE c.id = ?
        `;
        
        // Ejecutamos usando tu formato de promesas
        const [clienteRows] = await db.execute(queryCliente, [idCliente]);

        // Si no hay cliente, retornamos error 404
        if (clienteRows.length === 0) {
            return res.status(404).json({ error: 'Cliente no encontrado' });
        }

        // Consulta 2: Historial de pagos + Nombre del usuario que cobró
        const queryPagos = `
            SELECT p.*, u.nombre AS cobrador_nombre 
            FROM pagos p 
            LEFT JOIN usuarios u ON p.usuario_id = u.id 
            WHERE p.cliente_id = ? AND p.estado_corte IN (0, 1) 
            ORDER BY p.id DESC
        `;
        
        // Ejecutamos la consulta de pagos
        const [pagosRows] = await db.execute(queryPagos, [idCliente]);

        // Enviamos el paquete completo de regreso al navegador
        res.json({
            cliente: clienteRows[0], // Mandamos el objeto único del cliente
            pagos: pagosRows         // Mandamos el arreglo completo de pagos
        });

    } catch (error) {
        // Manejo de errores siguiendo tu estructura
        console.error("Error al obtener perfil completo:", error);
        res.status(500).json({ error: 'Error interno del servidor al consultar la base de datos' });
    }
}); */


