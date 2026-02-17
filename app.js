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
db.connect((err) => {
    if (err) {
        console.error('Error al conectar a MySQL: ', err);
        return;
    }
    console.log('✅ Conectado exitosamente a la base de datos MySQL');
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
app.post('/api/clientes', (req, res) => {
    const { nombre_completo, telefono, correo, direccion } = req.body;

    // Validación básica
    if (!nombre_completo) {
        return res.status(400).json({ error: "El nombre es obligatorio" });
    }

    const query = `INSERT INTO clientes (nombre_completo, telefono, correo, direccion) 
                   VALUES (?, ?, ?, ?)`;
    
    db.query(query, [nombre_completo, telefono, correo, direccion], (err, result) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ error: "Error al guardar el cliente" });
        }
        res.json({ success: true, mensaje: "Cliente registrado con éxito", id: result.insertId });
    });
});