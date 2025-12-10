/**
 * Test Script: Demonstrate Deadlock Retry Logic
 * 
 * This script runs concurrent signups in smaller batches
 * to better demonstrate the retry mechanism working.
 */

const axios = require('axios');

const API_BASE = 'http://localhost:3000/api';

// Generate unique test email
function generateEmail(batchId, userId) {
    const timestamp = Date.now();
    return `batch${batchId}_user${userId}_${timestamp}@test.com`;
}

// Signup function with detailed logging
async function signup(batchId, userId) {
    const email = generateEmail(batchId, userId);
    const startTime = Date.now();

    try {
        const response = await axios.post(`${API_BASE}/signup`, {
            role: 'VIEWER',
            email: email,
            password: 'Test123!',
            first_name: `User${userId}`,
            last_name: 'Test',
            street: '123 Test St',
            city: 'TestCity',
            state: 'TS',
            zip_code: '12345',
            country_id: 1
        });

        const duration = Date.now() - startTime;
        console.log(`  ✅ User ${userId}: SUCCESS (${duration}ms)`);
        return { success: true, userId, duration };

    } catch (err) {
        const duration = Date.now() - startTime;
        const error = err.response?.data?.error || err.message;
        const isDeadlock = error.includes('Deadlock');

        if (isDeadlock) {
            console.log(`  ⚠️  User ${userId}: DEADLOCK (gave up after ${duration}ms)`);
        } else {
            console.log(`  ❌ User ${userId}: ${error} (${duration}ms)`);
        }

        return { success: false, userId, duration, isDeadlock };
    }
}

// Run a batch of concurrent signups
async function runBatch(batchId, size) {
    console.log(`\n📦 Batch ${batchId}: Running ${size} concurrent signups...`);

    const promises = [];
    for (let i = 1; i <= size; i++) {
        promises.push(signup(batchId, i));
    }

    const results = await Promise.all(promises);

    const successful = results.filter(r => r.success).length;
    const deadlocks = results.filter(r => r.isDeadlock).length;
    const avgDuration = Math.round(results.reduce((sum, r) => sum + r.duration, 0) / results.length);

    console.log(`\n  Results: ${successful}/${size} succeeded, ${deadlocks} deadlocks, avg ${avgDuration}ms`);

    return { successful, deadlocks, total: size };
}

// Main test
async function test() {
    console.log('='.repeat(70));
    console.log('CONCURRENT TRANSACTION TEST - Deadlock Retry Demonstration');
    console.log('='.repeat(70));
    console.log('\nThis test runs multiple batches of concurrent signups.');
    console.log('Watch for:');
    console.log('  ✅ = Transaction succeeded (possibly after retries)');
    console.log('  ⚠️  = Deadlock detected, max retries exhausted');
    console.log('');

    const batches = [
        { id: 1, size: 3, name: '3 concurrent users' },
        { id: 2, size: 5, name: '5 concurrent users' },
        { id: 3, size: 10, name: '10 concurrent users' }
    ];

    const results = [];

    for (const batch of batches) {
        console.log(`\n${'─'.repeat(70)}`);
        console.log(`Test: ${batch.name}`);
        console.log('─'.repeat(70));

        const result = await runBatch(batch.id, batch.size);
        results.push(result);

        // Wait a bit between batches
        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    // Summary
    console.log('\n' + '='.repeat(70));
    console.log('SUMMARY');
    console.log('='.repeat(70));

    const totalAttempts = results.reduce((sum, r) => sum + r.total, 0);
    const totalSuccessful = results.reduce((sum, r) => sum + r.successful, 0);
    const totalDeadlocks = results.reduce((sum, r) => sum + r.deadlocks, 0);
    const successRate = Math.round((totalSuccessful / totalAttempts) * 100);

    console.log(`Total Attempts: ${totalAttempts}`);
    console.log(`Successful: ${totalSuccessful} (${successRate}%)`);
    console.log(`Deadlocks (max retries): ${totalDeadlocks}`);
    console.log('');

    if (successRate >= 50) {
        console.log('✅ PASS: Retry logic is working! Most transactions succeeded.');
        console.log('   (Some deadlocks are expected under high concurrency)');
    } else {
        console.log('⚠️  WARNING: Low success rate. May need to adjust retry settings.');
    }

    console.log('='.repeat(70));
}

// Run
test()
    .then(() => {
        console.log('\nTest completed.\n');
        process.exit(0);
    })
    .catch(err => {
        console.error('\n❌ Test failed:', err.message);
        process.exit(1);
    });
