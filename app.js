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

// Ejemplo: Obtener todos los clientes (Para ver si la DB responde)
app.get('/api/clientes', async (req, res) => {
    const query = 'SELECT * FROM clientes';
    try{
        const [results] = await db.query(query);
        res.json(results);    
    }catch{
        res.status(500).json({ error: err.message });
    }
    db.query(query, (err, results) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(results);
    });
});

// Ruta para iniciar sesión (Login)
// Agregamos "async" aquí
app.post('/api/login', async (req, res) => {
    const { correo, password } = req.body;
    
    const query = 'SELECT id, nombre, rol_id FROM usuarios WHERE correo = ? AND password = ?';

    try {
        // Usamos "await" y extraemos los resultados en un arreglo [results]
        const [results] = await db.query(query, [correo, password]);

        if (results.length > 0) {
            // Usuario encontrado
            console.log('Usuario encontrado');
            const usuario = results[0];
            res.json({
                success: true,
                mensaje: "Bienvenido",
                user: {
                    id: usuario.id,
                    nombre: usuario.nombre,
                    rol: usuario.rol_id // 1 = Recepcionista, 2 = Admin
                }
            });
        } else {
            // Datos incorrectos
            console.log('Usuario no encontrado');
            res.status(401).json({ success: false, mensaje: "Correo o contraseña incorrectos" });
        }
    } catch (err) {
        // Si hay un error en MySQL, cae aquí
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
    const { 
        nombre_completo, telefono, correo, direccion, 
        fecha_instalacion, dia_pago, direccion_ip, señal, paquete, costo_mensual 
    } = req.body;

    const query = `INSERT INTO clientes 
                   (nombre_completo, telefono, correo, direccion, fecha_instalacion, dia_pago, direccion_ip, señal, paquete, costo_mensual) 
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    // 2. Abrimos el bloque try/catch
    try{
        // 3. Usamos 'await' y extraemos [result] (Borramos el callback)
        const [result] = await db.query(query, [
            nombre_completo, telefono, correo, direccion, 
            fecha_instalacion, dia_pago, direccion_ip, señal, paquete, costo_mensual
        ]);
        // 4a. Si todo sale bien, respondemos aquí
        res.json({ success: true, mensaje: "Cliente creado con éxito" });
    }catch{
        // 4b. Si hay un error, el 'catch' lo atrapa automáticamente
        console.error("Error al crear cliente:", error);
        res.status(500).json("error al guardar en la BD"+{ error: err.message });
    }
});

// Ruta para buscar clientes por nombre o IP
app.get('/api/buscar-clientes', (req, res) => {
    const term = req.query.q; //Lo que el cliente escribe
    // Agregamos fecha_instalacion a la consulta
    const query = `
        SELECT id, nombre_completo, direccion_ip, costo_mensual, fecha_instalacion 
        FROM clientes 
        WHERE nombre_completo LIKE ? OR direccion_ip LIKE ?
        LIMIT 10`;

    db.query(query, [`%${term}%`, `%${term}%`], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

// RUTA 1: Consultar el último pago de un cliente
app.get('/api/ultimo-pago/:id', (req, res) => {
    const { id } = req.params;
    const query = `
        SELECT mes_pagado, fecha_pago, monto,  tipo_pago
        FROM pagos 
        WHERE cliente_id = ? 
        ORDER BY fecha_pago DESC LIMIT 1`;

    db.query(query, [id], (err, results) => {
        if (err) {
            console.error("Error en DB:", err);
            return res.status(500).json({ error: "Error al consultar historial" });
        }
        // Si hay resultados, mandamos el primero, si no, mandamos null
        res.json(results.length > 0 ? results[0] : null);
    });
});

app.post('/api/registrar-pago', async (req, res) => {
    const { clienteId, montoRecibido, usuarioId } = req.body;

    try {
        const [cliente] = await db.promise().query('SELECT costo_mensual, fecha_instalacion, dia_pago FROM clientes WHERE id = ?', [clienteId]);
        if (!cliente.length) return res.status(404).json({ error: "Cliente no encontrado" });
        const { costo_mensual, fecha_instalacion } = cliente[0];

        // 1. Traemos TODO el historial agrupado por mes de este cliente
        const [pagosAgrupados] = await db.promise().query(
            'SELECT mes_pagado, SUM(monto) as pagado FROM pagos WHERE cliente_id = ? GROUP BY mes_pagado',
            [clienteId]
        );

        // Convertimos a un diccionario para lectura súper rápida (Ej: { "Mayo 2023": 600, "Junio 2023": 200 })
        const historial = {};
        pagosAgrupados.forEach(p => { historial[p.mes_pagado] = parseFloat(p.pagado); });
        console.log('PAgos Agrupados '+ pagosAgrupados)

        // 2. EL ESCÁNER CRONOLÓGICO
        let fechaReferencia = new Date(fecha_instalacion);

        // --- CAMBIO AQUÍ: Saltamos al mes siguiente de la instalación ---
        fechaReferencia.setMonth(fechaReferencia.getMonth() + 1);
        // ----------------------------------------------------------------

        const nombresMeses = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
        let saldoRestante = parseFloat(montoRecibido);
        const registros = [];

        // Caminamos mes a mes hacia el futuro
        while (saldoRestante > 0) {
            let mesActual = nombresMeses[fechaReferencia.getMonth()];
            let anioActual = fechaReferencia.getFullYear();
            let etiquetaMes = `${mesActual} ${anioActual}`;

            let pagadoEnEsteMes = historial[etiquetaMes] || 0;
            let pendienteMes = costo_mensual - pagadoEnEsteMes;

            // Si este mes tiene deuda (ya sea completo o falta un abono)
            if (pendienteMes > 0) {
                let montoAAplicar = Math.min(saldoRestante, pendienteMes);
                let nuevoTipo = (montoAAplicar >= pendienteMes && pagadoEnEsteMes === 0) ? 'completo' : 'abono';
                
                // Forzamos que si completa el mes con este abono, diga completo.
                if (pagadoEnEsteMes + montoAAplicar >= costo_mensual) nuevoTipo = 'completo';

                // INSERTAMOS EL PAGO
                await db.promise().query(
                    'INSERT INTO pagos (cliente_id, usuario_id, monto, mes_pagado, tipo_pago) VALUES (?, ?, ?, ?, ?)',
                    [clienteId, usuarioId, montoAAplicar, etiquetaMes, nuevoTipo]
                );

                registros.push({ mes: etiquetaMes, monto: montoAAplicar, tipo: nuevoTipo });
                
                saldoRestante -= montoAAplicar;
                historial[etiquetaMes] = pagadoEnEsteMes + montoAAplicar; // Actualizamos memoria local
            }

            // Avanzamos al siguiente mes
            fechaReferencia.setMonth(fechaReferencia.getMonth() + 1);

            // Seguro de vida: Si por error de fechas se va al año 2050, detenemos el bucle
            if (fechaReferencia.getFullYear() > new Date().getFullYear() + 2) break; 
        }

        res.json({ success: true, detalle: registros });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Error interno procesando el cobro" });
    }
});

app.get('/api/estado-cuenta/:id', async (req, res) => {
    try {
        const clienteId = req.params.id;
        const [resultado] = await db.promise().query(
            'SELECT SUM(monto) as total_pagado FROM pagos WHERE cliente_id = ?',
            [clienteId]
        );
        res.json({ total_pagado: resultado[0].total_pagado || 0 });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 1. Ruta para obtener el total y la lista de pagos sin entregar (estado_corte = 0)
app.get('/api/corte-caja/:usuarioId', async (req, res) => {
    const { usuarioId } = req.params;
    try {
        const [resumen] = await db.promise().query(
            'SELECT COUNT(id) as total_cobros, SUM(monto) as total_dinero FROM pagos WHERE usuario_id = ? AND estado_corte = 0',
            [usuarioId]
        );
        const [detalles] = await db.promise().query(
            `SELECT p.id, p.fecha_pago, c.nombre_completo as cliente, p.mes_pagado, p.monto 
             FROM pagos p 
             JOIN clientes c ON p.cliente_id = c.id 
             WHERE p.usuario_id = ? AND p.estado_corte = 0 
             ORDER BY p.fecha_pago DESC`,
            [usuarioId]
        );
        res.json({ resumen: resumen[0], detalles: detalles });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 2. Ruta para AUTORIZAR y procesar el corte
app.post('/api/procesar-corte', async (req, res) => {
    const { usuarioId, adminUser, adminPassword } = req.body;
    try {
        // A) Validamos al administrador (Ajusta 'usuarios' según el nombre real de tu tabla de login)
        const [admins] = await db.promise().query(
            'SELECT id FROM usuarios WHERE correo = ? AND password = ? AND rol_id = "2"', 
            [adminUser, adminPassword]
        );
        
        if (admins.length === 0) {
            return res.status(401).json({ error: "Credenciales de administrador incorrectas." });
        }

        // B) Si el admin es correcto, cambiamos el estado de 0 a 1
        await db.promise().query(
            'UPDATE pagos SET estado_corte = 1 WHERE usuario_id = ? AND estado_corte = 0',
            [usuarioId]
        );
        
        res.json({ success: true, message: "Corte autorizado y procesado con éxito." });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});