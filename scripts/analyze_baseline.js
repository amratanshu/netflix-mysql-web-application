/**
 * Baseline Performance Analysis
 * 
 * This script analyzes query performance BEFORE indexing
 * to establish baseline metrics for comparison.
 */

require('dotenv').config();
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
});

async function analyzeQuery(description, query, params = []) {
    console.log(`\n${'='.repeat(70)}`);
    console.log(`Query: ${description}`);
    console.log('='.repeat(70));

    try {
        // Run EXPLAIN
        const explainQuery = `EXPLAIN ${query}`;
        const [explainResults] = await pool.query(explainQuery, params);

        console.log('\nEXPLAIN Results:');
        console.table(explainResults);

        // Run actual query and measure time
        const startTime = Date.now();
        const [results] = await pool.query(query, params);
        const endTime = Date.now();
        const duration = endTime - startTime;

        console.log(`\nExecution Time: ${duration}ms`);
        console.log(`Rows Returned: ${results.length}`);

        // Extract key metrics from EXPLAIN
        const firstRow = explainResults[0];
        console.log(`\nKey Metrics:`);
        console.log(`  Type: ${firstRow.type}`);
        console.log(`  Possible Keys: ${firstRow.possible_keys || 'NONE'}`);
        console.log(`  Key Used: ${firstRow.key || 'NONE'}`);
        console.log(`  Rows Examined: ${firstRow.rows}`);

        return {
            description,
            duration,
            rowsReturned: results.length,
            rowsExamined: firstRow.rows,
            type: firstRow.type,
            keyUsed: firstRow.key || 'NONE'
        };

    } catch (err) {
        console.error(`Error analyzing query: ${err.message}`);
        return null;
    }
}

async function runBaselineAnalysis() {
    console.log('\n' + '█'.repeat(70));
    console.log('DATABASE PERFORMANCE BASELINE ANALYSIS');
    console.log('Running BEFORE indexing');
    console.log('█'.repeat(70));

    const results = [];

    // Query 1: User login by email
    results.push(await analyzeQuery(
        'User Login (Email Lookup)',
        'SELECT user_id, email, password_hash, role FROM AA_USERS WHERE email = ?',
        ['admin@netflix.com']
    ));

    // Query 2: Production house search by name
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

    // Query 5: Browse with filters
    results.push(await analyzeQuery(
        'Browse with Language/Genre Filter',
        'SELECT * FROM AA_WEB_SERIES WHERE original_language_id = ? AND genre_id = ?',
        [1, 1]
    ));

    // Summary
    console.log('\n' + '█'.repeat(70));
    console.log('BASELINE SUMMARY');
    console.log('█'.repeat(70));
    console.log('\nPerformance Metrics:');

    const validResults = results.filter(r => r !== null);
    const totalDuration = validResults.reduce((sum, r) => sum + r.duration, 0);
    const avgDuration = totalDuration / validResults.length;
    const totalRowsExamined = validResults.reduce((sum, r) => sum + r.rowsExamined, 0);

    console.log(`  Total Queries: ${validResults.length}`);
    console.log(`  Total Execution Time: ${totalDuration}ms`);
    console.log(`  Average Execution Time: ${avgDuration.toFixed(2)}ms`);
    console.log(`  Total Rows Examined: ${totalRowsExamined}`);
    console.log(`  Queries Using Index: ${validResults.filter(r => r.keyUsed !== 'NONE').length}`);
    console.log(`  Queries Using Full Scan: ${validResults.filter(r => r.type === 'ALL').length}`);

    console.log('\n' + '█'.repeat(70));

    // Save results to file
    const fs = require('fs');
    fs.writeFileSync(
        'baseline_results.json',
        JSON.stringify({ timestamp: new Date(), results: validResults }, null, 2)
    );
    console.log('\n✅ Baseline results saved to baseline_results.json');

    await pool.end();
}

// Run analysis
runBaselineAnalysis()
    .then(() => {
        console.log('\n✅ Baseline analysis complete!\n');
        process.exit(0);
    })
    .catch(err => {
        console.error('\n❌ Analysis failed:', err);
        process.exit(1);
    });
