const mysql = require('mysql2');

// Creamos la conexión
const connection = mysql.createConnection({
  host: 'localhost',
  user: 'root',      // Tu usuario de MySQL
  password: 'Servidores2024$+', 
  database: 'sistema_pagos_internet'
});

connection.connect((err) => {
  if (err) {
    console.error('Error conectando a la base de datos: ' + err.stack);
    return;
  }
  console.log('¡Conectado a MySQL con éxito!');
});

module.exports = connection;