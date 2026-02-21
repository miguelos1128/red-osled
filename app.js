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
    const term = req.query.q; // Lo que el usuario escribe
    const query = `
        SELECT id, nombre_completo, direccion_ip, costo_mensual 
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