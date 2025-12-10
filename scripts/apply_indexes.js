/**
 * Apply Performance Indexes
 * 
 * This script creates indexes on frequently queried columns
 * to optimize database performance.
 */

require('dotenv').config();
const mysql = require('mysql2/promise');
const fs = require('fs');

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
});

async function applyIndexes() {
    console.log('\n' + '█'.repeat(70));
    console.log('APPLYING PERFORMANCE INDEXES');
    console.log('█'.repeat(70));

    const indexes = [
        {
            name: 'idx_production_house_name',
            table: 'AA_PRODUCTION_HOUSE',
            column: 'ph_name',
            sql: 'CREATE INDEX idx_production_house_name ON AA_PRODUCTION_HOUSE(ph_name)'
        },
        {
            name: 'idx_series_name',
            table: 'AA_WEB_SERIES',
            column: 'series_name',
            sql: 'CREATE INDEX idx_series_name ON AA_WEB_SERIES(series_name)'
        },
        {
            name: 'idx_country_name',
            table: 'AA_COUNTRY',
            column: 'country_name',
            sql: 'CREATE INDEX idx_country_name ON AA_COUNTRY(country_name)'
        },
        {
            name: 'idx_series_language',
            table: 'AA_WEB_SERIES',
            column: 'original_language_id',
            sql: 'CREATE INDEX idx_series_language ON AA_WEB_SERIES(original_language_id)'
        }
    ];

    let created = 0;
    let skipped = 0;

    for (const index of indexes) {
        try {
            console.log(`\n📊 Creating index: ${index.name}`);
            console.log(`   Table: ${index.table}`);
            console.log(`   Column: ${index.column}`);

            await pool.query(index.sql);
            console.log(`   ✅ Created successfully`);
            created++;

        } catch (err) {
            if (err.code === 'ER_DUP_KEYNAME') {
                console.log(`   ⚠️  Already exists, skipping`);
                skipped++;
            } else {
                console.log(`   ❌ Error: ${err.message}`);
            }
        }
    }

    console.log('\n' + '█'.repeat(70));
    console.log('SUMMARY');
    console.log('█'.repeat(70));
    console.log(`  Indexes Created: ${created}`);
    console.log(`  Already Existed: ${skipped}`);
    console.log(`  Total Indexes: ${indexes.length}`);
    console.log('█'.repeat(70));

    await pool.end();
}

// Run
applyIndexes()
    .then(() => {
        console.log('\n✅ Indexes applied successfully!\n');
        process.exit(0);
    })
    .catch(err => {
        console.error('\n❌ Failed to apply indexes:', err);
        process.exit(1);
    });
