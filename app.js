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
const db = mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
});

// Conectar a la base de datos
// Conectar a la base de datos
db.connect((err) => {
    if (err) {
        console.error('Error al conectar a MySQL: ', err);
        return;
    }
    console.log('------------------------------------------------');
    console.log('✅ Conectado a la Base de Datos: ' + process.env.DB_NAME);
    console.log('------------------------------------------------');
    
    if(process.env.DB_NAME === 'sistema_pagos_produccion') {
        console.warn('⚠️  CUIDADO: ESTÁS EN MODO PRODUCCIÓN (DATOS REALES) ⚠️');
    } else {
        console.log('🛠️  Modo Pruebas (Puedes hacer desastres con confianza)');
    }
});

// 4. Rutas de prueba (Endpoints)

// Ruta básica para verificar que el servidor funciona
app.get('/', (req, res) => {
    res.send('Servidor de Pagos de Internet funcionando 🚀');
});

// Ejemplo: Obtener todos los clientes (Para ver si la DB responde)
app.get('/api/clientes', (req, res) => {
    const query = 'SELECT * FROM clientes';
    db.query(query, (err, results) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(results);
    });
});

// Ruta para iniciar sesión (Login)
app.post('/api/login', (req, res) => {
    const { correo, password } = req.body;

    const query = 'SELECT id, nombre, rol_id FROM usuarios WHERE correo = ? AND password = ?';
    
    db.query(query, [correo, password], (err, results) => {
        if (err) return res.status(500).json({ error: "Error en el servidor" });

        if (results.length > 0) {
            // Usuario encontrado
            console.log('Usuario encontrado')
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
            console.log('Usuario no encontrado')
            res.status(401).json({ success: false, mensaje: "Correo o contraseña incorrectos" });
        }
    });
});

// 5. Iniciar el servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`📡 Servidor corriendo en http://localhost:${PORT}`);
});

// Ruta para agregar un nuevo cliente (POST)
// Ruta actualizada para agregar un nuevo cliente
app.post('/api/clientes', (req, res) => {
    const { 
        nombre_completo, telefono, correo, direccion, 
        fecha_instalacion, dia_pago, direccion_ip, señal, paquete, costo_mensual 
    } = req.body;

    const query = `INSERT INTO clientes 
                   (nombre_completo, telefono, correo, direccion, fecha_instalacion, dia_pago, direccion_ip, señal, paquete, costo_mensual) 
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    
    db.query(query, [
        nombre_completo, telefono, correo, direccion, 
        fecha_instalacion, dia_pago, direccion_ip, señal, paquete, costo_mensual
    ], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, mensaje: "Cliente creado con éxito" });
    });
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
        SELECT mes_pagado, fecha_pago, monto 
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
        // 1. Obtener datos del cliente (Costo y Fecha Instalación)
        const [cliente] = await db.promise().query(
            'SELECT costo_mensual, fecha_instalacion FROM clientes WHERE id = ?', 
            [clienteId]
        );

        if (!cliente.length) return res.status(404).json({ error: "Cliente no encontrado" });
        const { costo_mensual, fecha_instalacion } = cliente[0];

        // 2. Obtener el último mes pagado (si existe)
        const [ultimoPago] = await db.promise().query(
            'SELECT mes_pagado, fecha_pago FROM pagos WHERE cliente_id = ? ORDER BY id DESC LIMIT 1',
            [clienteId]
        );

        let saldoRestante = parseFloat(montoRecibido);
        let fechaReferencia;

        if (ultimoPago.length > 0) {
            // Si ya tiene pagos, extraemos el mes y año del string "Mes Año" (ej: "Enero 2025")
            const partes = ultimoPago[0].mes_pagado.split(' ');
            const mesTexto = partes[0];
            const año = parseInt(partes[1]);
            
            const mesesMap = { "Enero":0, "Febrero":1, "Marzo":2, "Abril":3, "Mayo":4, "Junio":5, "Julio":6, "Agosto":7, "Septiembre":8, "Octubre":9, "Noviembre":10, "Diciembre":11 };
            
            // Creamos la fecha de referencia un mes DESPUÉS del último pago
            fechaReferencia = new Date(año, mesesMap[mesTexto] + 1, 1);
        } else {
            // Cliente nuevo
            fechaReferencia = new Date(fecha_instalacion);
        }

        const registros = [];
        const nombresMeses = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];

        // 3. BUCLE DE CASCADA 🌊
        while (saldoRestante > 0) {
            let mesNombre = nombresMeses[fechaReferencia.getMonth()];
            let año = fechaReferencia.getFullYear();
            let etiquetaMes = `${mesNombre} ${año}`;
            
            let montoAAplicar = 0;
            let tipo = 'completo';

            if (saldoRestante >= costo_mensual) {
                // Cubre el mes completo
                montoAAplicar = costo_mensual;
                saldoRestante -= costo_mensual;
                tipo = 'completo';
            } else {
                // Es un abono parcial
                montoAAplicar = saldoRestante;
                saldoRestante = 0;
                tipo = 'abono';
            }

            // Guardar en la base de datos
            await db.promise().query(
                'INSERT INTO pagos (cliente_id, usuario_id, monto, mes_pagado, tipo_pago) VALUES (?, ?, ?, ?, ?)',
                [clienteId, usuarioId, montoAAplicar, etiquetaMes, tipo]
            );

            registros.push({ mes: etiquetaMes, monto: montoAAplicar, tipo });
            
            // Avanzar al siguiente mes para la siguiente iteración
            fechaReferencia.setMonth(fechaReferencia.getMonth() + 1);
        }

        res.json({ success: true, detalle: registros });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Error al procesar el pago en cascada" });
    }
});