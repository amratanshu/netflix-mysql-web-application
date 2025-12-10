/**
 * Post-Index Performance Analysis
 * 
 * This script analyzes query performance AFTER indexing
 * and compares with baseline metrics.
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

async function analyzeQuery(description, query, params = []) {
    try {
        // Run EXPLAIN
        const explainQuery = `EXPLAIN ${query}`;
        const [explainResults] = await pool.query(explainQuery, params);

        // Run actual query and measure time
        const startTime = Date.now();
        const [results] = await pool.query(query, params);
        const endTime = Date.now();
        const duration = endTime - startTime;

        const firstRow = explainResults[0];

        return {
            description,
            duration,
            rowsReturned: results.length,
            rowsExamined: firstRow.rows,
            type: firstRow.type,
            keyUsed: firstRow.key || 'NONE'
        };

    } catch (err) {
        return null;
    }
}

async function runComparison() {
    console.log('\n' + '█'.repeat(70));
    console.log('POST-INDEX PERFORMANCE ANALYSIS & COMPARISON');
    console.log('█'.repeat(70));

    // Load baseline results
    let baseline = null;
    try {
        const baselineData = fs.readFileSync('baseline_results.json', 'utf8');
        baseline = JSON.parse(baselineData);
    } catch (err) {
        console.log('⚠️  No baseline results found, running standalone analysis');
    }

    const results = [];

    // Query 1: User login by email
    results.push(await analyzeQuery(
        'User Login (Email Lookup)',
        'SELECT user_id, email, password_hash, role FROM AA_USERS WHERE email = ?',
        ['admin@netflix.com']
    ));

    // Query 2: Production house search by name (THIS SHOULD BE IMPROVED)
    results.push(await analyzeQuery(
        'Production House Search',
        'SELECT * FROM AA_PRODUCTION_HOUSE WHERE ph_name LIKE ?',
        ['%Warner%']
    ));

    // Query 3: Series by production house
    results.push(await analyzeQuery(
        'Series by Production House',
        'SELECT * FROM AA_WEB_SERIES WHERE production_house_id = ?',
        [1]
    ));

    // Query 4: View history by account
    results.push(await analyzeQuery(
        'View History by Account',
        'SELECT * FROM AA_VIEW_HISTORY WHERE account_id = ?',
        [1]
    ));

    // Comparison
    console.log('\n' + '█'.repeat(70));
    console.log('PERFORMANCE COMPARISON');
    console.log('█'.repeat(70));

    if (baseline && baseline.results) {
        console.log('\n┌─────────────────────────────────────────────────────────────────┐');
        console.log('│ Query Performance: BEFORE vs AFTER Indexing                    │');
        console.log('└─────────────────────────────────────────────────────────────────┘\n');

        results.forEach((after, i) => {
            if (!after) return;

            const before = baseline.results[i];
            if (!before) return;

            const timeDiff = before.duration - after.duration;
            const improvement = before.duration > 0
                ? ((timeDiff / before.duration) * 100).toFixed(1)
                : 0;

            console.log(`\n📊 ${after.description}`);
            console.log('─'.repeat(70));
            console.log(`  Execution Time:`);
            console.log(`    Before: ${before.duration}ms`);
            console.log(`    After:  ${after.duration}ms`);
            console.log(`    Change: ${timeDiff >= 0 ? '↓' : '↑'} ${Math.abs(timeDiff)}ms (${improvement >= 0 ? improvement : 0}% ${improvement >= 0 ? 'faster' : 'slower'})`);

            console.log(`  Index Usage:`);
            console.log(`    Before: ${before.keyUsed}`);
            console.log(`    After:  ${after.keyUsed}`);

            console.log(`  Scan Type:`);
            console.log(`    Before: ${before.type}`);
            console.log(`    After:  ${after.type}`);

            if (before.type === 'ALL' && after.type !== 'ALL') {
                console.log(`    ✅ IMPROVED: No longer using full table scan!`);
            }
        });

        // Overall summary
        const validResults = results.filter(r => r !== null);
        const totalAfter = validResults.reduce((sum, r) => sum + r.duration, 0);
        const totalBefore = baseline.results.reduce((sum, r) => sum + r.duration, 0);
        const overallImprovement = ((totalBefore - totalAfter) / totalBefore * 100).toFixed(1);

        console.log('\n' + '█'.repeat(70));
        console.log('OVERALL SUMMARY');
        console.log('█'.repeat(70));
        console.log(`  Total Execution Time Before: ${totalBefore}ms`);
        console.log(`  Total Execution Time After:  ${totalAfter}ms`);
        console.log(`  Overall Improvement: ${overallImprovement}% faster`);
        console.log(`  Indexes Created: 4`);
        console.log(`  Full Table Scans Eliminated: ${baseline.results.filter(r => r.type === 'ALL').length - validResults.filter(r => r.type === 'ALL').length}`);
        console.log('█'.repeat(70));
    }

    await pool.end();
}

// Run
runComparison()
    .then(() => {
        console.log('\n✅ Performance analysis complete!\n');
        process.exit(0);
    })
    .catch(err => {
        console.error('\n❌ Analysis failed:', err);
        process.exit(1);
    });
