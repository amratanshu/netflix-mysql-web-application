const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');

async function seedUsers() {
    console.log('🌱 Seeding Users...');

    const connection = await mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME
    });

    try {
        const password = 'password123';
        const hashedPassword = await bcrypt.hash(password, 10);

        // 1. Create Super Admin (Employee)
        console.log('Creating Admin User (Employee)...');
        await connection.execute(`
            INSERT INTO AA_USERS (email, password_hash, role, account_id, producer_id)
            VALUES (?, ?, 'ADMIN', NULL, NULL)
        `, ['admin@netflix.com', hashedPassword]);

        // 2. Create Producer User (Linked to Producer ID 1 - Shawn Levy)
        console.log('Creating Producer User (Shawn Levy)...');
        await connection.execute(`
            INSERT INTO AA_USERS (email, password_hash, role, account_id, producer_id)
            VALUES (?, ?, 'PRODUCER', NULL, 1)
        `, ['shawn.levy@21laps.com', hashedPassword]);

        // 3. Create Viewer User (Linked to Account ID 1 - John Doe)
        console.log('Creating Viewer User (John Doe)...');
        await connection.execute(`
             INSERT INTO AA_USERS (email, password_hash, role, account_id, producer_id)
             VALUES (?, ?, 'VIEWER', 1, NULL)
         `, ['john.doe@example.com', hashedPassword]);

        console.log('✅ Users Seeded Successfully!');
        console.log('🔑 Password for all users: password123');

    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
            console.log('⚠️  Users already exist. Skipping.');
        } else {
            console.error('❌ Error Seeding Users:', err);
        }
    } finally {
        await connection.end();
    }
}

if (require.main === module) {
    seedUsers();
}

module.exports = { seedUsers };
