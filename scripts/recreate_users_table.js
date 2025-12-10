const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const mysql = require('mysql2/promise');
const { seedUsers } = require('./seed_users');

async function resetAuth() {
    console.log('🔄 resetting AA_USERS table...');

    const connection = await mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        multipleStatements: true // Enable multiple statements for SQL file execution
    });

    try {
        // 1. Drop existing table
        await connection.execute('DROP TABLE IF EXISTS AA_USERS');
        console.log('Dropped AA_USERS table.');

        // 2. Read and Execute init_users.sql
        const sqlPath = path.join(__dirname, 'init_users.sql');
        const sqlHelper = fs.readFileSync(sqlPath, 'utf8');

        // multipleStatements allows running the whole file
        await connection.query(sqlHelper);
        console.log('Recreated AA_USERS table from schema.');

        // 3. Run Seed
        console.log('Running Seed...');
        await seedUsers();

    } catch (err) {
        console.error('❌ Error resetting auth:', err);
    } finally {
        await connection.end();
    }
}

resetAuth();
