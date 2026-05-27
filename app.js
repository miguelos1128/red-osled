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
                c.id, c.nombre_completo, c.telefono, c.es_renta, fecha_instalacion, c.direccion_ip, c.costo_mensual, c.dia_pago, c.localidad_id,
                IFNULL(GROUP_CONCAT(CONCAT(p.mes_pagado, ':', p.estado_corte) SEPARATOR ','), '') as historial_pagos
            FROM clientes c
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
            GROUP BY c.id, c.nombre_completo, c.telefono, c.es_renta, c.direccion_ip, c.costo_mensual, c.dia_pago, c.localidad_id
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

        const estadoCuenta = calcularEstadoCuentaServidor(clienteData, pagosExistentes);
        const registros = [];
        const aplicarPagoMes = async (etiquetaMes, pendienteMes) => {
            const pagadoAntes = historial[etiquetaMes] || 0;
            const montoAAplicar = Math.min(saldoRestante, pendienteMes);
            let nuevoTipo = (montoAAplicar >= pendienteMes && pagadoAntes === 0) ? 'completo' : 'abono';

            if (pagadoAntes + montoAAplicar >= costoMensual) nuevoTipo = 'completo';

            await db.query(
                'INSERT INTO pagos (cliente_id, usuario_id, monto, mes_pagado, tipo_pago) VALUES (?, ?, ?, ?, ?)',
                [clienteId, usuarioId, montoAAplicar, etiquetaMes, nuevoTipo]
            );

            registros.push({ mes: etiquetaMes, monto: montoAAplicar, tipo: nuevoTipo });
            saldoRestante -= montoAAplicar;
            historial[etiquetaMes] = pagadoAntes + montoAAplicar;
        };

        for (const mesAdeudado of estadoCuenta.meses_adeudados) {
            if (saldoRestante <= 0) break;
            await aplicarPagoMes(mesAdeudado.mes, mesAdeudado.pendiente);
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
            const pendienteMes = Math.max(costoMensual - pagadoEnEsteMes, 0);

            if (pendienteMes > 0) {
                await aplicarPagoMes(etiquetaMes, pendienteMes);
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

function mesEstaVencido(anio, mesIndex, diaPago, hoy = new Date()) {
    const comparacionMes = compararMesContable(anio, mesIndex, hoy.getFullYear(), hoy.getMonth());

    if (comparacionMes < 0) return true;
    if (comparacionMes > 0) return false;

    const ultimoDia = obtenerUltimoDiaMes(anio, mesIndex);
    const diaVencimiento = Math.min(diaPago, ultimoDia);
    return hoy.getDate() >= diaVencimiento;
}

function calcularEstadoCuentaServidor(cliente, pagos) {
    const costoMensual = parseFloat(cliente.costo_mensual) || 0;
    const fechaInstalacion = new Date(cliente.fecha_instalacion);
    const diaPago = parseInt(cliente.dia_pago) || fechaInstalacion.getDate() || 1;
    const totalPagado = pagos.reduce((total, pago) => total + (parseFloat(pago.monto) || 0), 0);
    const pagosPorMes = {};

    pagos.forEach(pago => {
        const mes = pago.mes_pagado;
        pagosPorMes[mes] = (pagosPorMes[mes] || 0) + (parseFloat(pago.monto) || 0);
    });

    const mesesAdeudados = [];
    const mesesVencidos = [];
    let cursor = avanzarMesContable(fechaInstalacion.getFullYear(), fechaInstalacion.getMonth(), 1);
    const hoy = new Date();

    while (compararMesContable(cursor.anio, cursor.mesIndex, hoy.getFullYear(), hoy.getMonth()) <= 0) {
        if (mesEstaVencido(cursor.anio, cursor.mesIndex, diaPago, hoy)) {
            const etiquetaMes = obtenerEtiquetaMes(cursor.anio, cursor.mesIndex);
            const pagadoEnMes = pagosPorMes[etiquetaMes] || 0;
            const pendiente = Math.max(costoMensual - pagadoEnMes, 0);

            mesesVencidos.push(etiquetaMes);

            if (pendiente > 0) {
                mesesAdeudados.push({
                    mes: etiquetaMes,
                    monto_esperado: costoMensual,
                    monto_cubierto: Math.min(pagadoEnMes, costoMensual),
                    pendiente: pendiente
                });
            }
        }

        cursor = avanzarMesContable(cursor.anio, cursor.mesIndex, 1);
    }

    const mesesTranscurridos = mesesVencidos.length;
    const totalTeorico = mesesTranscurridos * costoMensual;
    const adeudoActual = mesesAdeudados.reduce((total, mes) => total + mes.pendiente, 0);
    const saldoFavor = Math.max(totalPagado - totalTeorico, 0);
    const mesesAdeudoDecimal = costoMensual > 0 ? adeudoActual / costoMensual : 0;

    return {
        total_pagado_historico: totalPagado,
        total_teorico: totalTeorico,
        adeudo_actual: adeudoActual,
        saldo_favor: saldoFavor,
        meses_transcurridos: mesesTranscurridos,
        meses_adeudo_decimal: Number(mesesAdeudoDecimal.toFixed(2)),
        meses_vencidos: mesesVencidos,
        meses_adeudados: mesesAdeudados
    };
}

app.get('/api/clientes/:id/estado-cuenta-completo', async (req, res) => {
    const clienteId = req.params.id;

    try {
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

        const estadoCuenta = calcularEstadoCuentaServidor(clienteRows[0], pagos);

        res.json({
            cliente: clienteRows[0],
            historial_pagos: pagos,
            estado_cuenta: estadoCuenta
        });
    } catch (error) {
        console.error('Error al calcular estado de cuenta completo:', error);
        res.status(500).json({ error: 'Error al calcular estado de cuenta del cliente' });
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
