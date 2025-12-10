const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const mysql = require('mysql2/promise');

async function listUsers() {
    const connection = await mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME
    });

    try {
        const [rows] = await connection.execute('SELECT * FROM AA_USERS');
        console.table(rows);
    } catch (err) {
        console.error('Error:', err);
    } finally {
        await connection.end();
    }
}

listUsers();
