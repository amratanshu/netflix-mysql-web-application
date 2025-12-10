require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const mysql = require('mysql2/promise');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware to parse JSON
app.use(express.json());
app.use(express.static('public')); // Serve frontend files

// Security: Disable Caching to prevent Back Button access after logout
app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    next();
});

// Database Connection Pool
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Test Connection
pool.getConnection()
    .then(connection => {
        console.log('✅ Connected to MySQL Database:', process.env.DB_NAME);
        connection.release();
    })
    .catch(err => {
        console.error('❌ Database Connection Failed:', err.message);
    });

// Basic Route
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date() });
});

const bcrypt = require('bcrypt');
const xss = require('xss');

// --- XSS PREVENTION ---

/**
 * Sanitize user input to prevent XSS attacks
 * Converts potentially malicious HTML/JavaScript into safe text
 * 
 * @param {Object} obj - Object containing user input fields
 * @returns {Object} Sanitized object with all string values cleaned
 */
function sanitizeInput(obj) {
    if (!obj || typeof obj !== 'object') return obj;

    const sanitized = {};
    for (let key in obj) {
        if (typeof obj[key] === 'string') {
            // Clean the string using xss library
            sanitized[key] = xss(obj[key]);
        } else if (typeof obj[key] === 'object' && obj[key] !== null) {
            // Recursively sanitize nested objects
            sanitized[key] = sanitizeInput(obj[key]);
        } else {
            // Keep non-string values as-is (numbers, booleans, etc.)
            sanitized[key] = obj[key];
        }
    }
    return sanitized;
}

// --- TRANSACTION UTILITIES FOR CONCURRENCY CONTROL ---

/**
 * Execute a database operation with transaction retry logic
 * Handles deadlocks automatically by retrying up to maxRetries times
 * 
 * @param {Function} operation - Async function that receives a connection and performs DB operations
 * @param {string} isolationLevel - Transaction isolation level (default: REPEATABLE READ)
 * @param {number} maxRetries - Maximum number of retry attempts for deadlocks (default: 3)
 * @returns {Promise} Result of the operation
 */
async function executeWithTransaction(operation, isolationLevel = 'REPEATABLE READ', maxRetries = 3) {
    let retries = maxRetries;
    let lastError;

    while (retries > 0) {
        const connection = await pool.getConnection();

        try {
            // Set isolation level for this transaction
            await connection.query(`SET TRANSACTION ISOLATION LEVEL ${isolationLevel}`);

            // Begin transaction
            await connection.beginTransaction();

            // Execute the operation
            const result = await operation(connection);

            // Commit transaction
            await connection.commit();

            return result;

        } catch (err) {
            // Rollback on any error
            await connection.rollback();

            // Check if it's a deadlock error
            if (err.code === 'ER_LOCK_DEADLOCK' && retries > 1) {
                console.log(`⚠️ Deadlock detected, retrying... (${maxRetries - retries + 1}/${maxRetries})`);
                retries--;
                lastError = err;

                // Wait a bit before retrying (exponential backoff)
                await new Promise(resolve => setTimeout(resolve, 100 * (maxRetries - retries + 1)));
                continue;
            }

            // If not a deadlock or out of retries, throw the error
            throw err;

        } finally {
            connection.release();
        }
    }

    // If we exhausted all retries, throw the last error
    throw lastError;
}

/**
 * Sleep utility for testing and backoff
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// --- API ROUTES ---

// Register Endpoint
app.post('/api/signup', async (req, res) => {
    // Sanitize all user inputs to prevent XSS attacks
    const sanitized = sanitizeInput(req.body);

    const {
        role, email, password,
        first_name, last_name,
        street, city, state, zip_code,
        country_id, suggested_country_name,
        phone
    } = sanitized;

    if (!email || !password || !first_name || !last_name || !role || !country_id || !zip_code) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    try {
        await executeWithTransaction(async (connection) => {
            // 1. Check if email already exists with FOR UPDATE lock
            // This prevents concurrent signups with the same email
            const [existing] = await connection.execute(
                'SELECT user_id FROM AA_USERS WHERE email = ? FOR UPDATE',
                [email]
            );

            if (existing.length > 0) {
                throw new Error('Email already registered');
            }

            // 2. Handle Country
            let countryIdToUse = country_id;

            // If "Other" (999) is selected, use it
            // The admin will review `suggested_country_name` later
            if (parseInt(country_id) === 999) {
                // Logic handled below in INSERT
            } else {
                // Standard flow: Use existing ID
            }

            const hashedPassword = await bcrypt.hash(password, 10);
            let accountId = null;
            let producerId = null;

            // 3. Create Entity based on Role
            if (role === 'VIEWER') {
                const [accountResult] = await connection.execute(
                    `INSERT INTO AA_VIEWER_ACCOUNT 
                    (viewer_email, viewer_first_name, viewer_last_name, viewer_street, viewer_city, viewer_state, viewer_zip_code, viewer_country_id, suggested_country_name, date_opened, monthly_service_charge) 
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), 15.00)`,
                    [email, first_name, last_name, street, city, state, zip_code, countryIdToUse, suggested_country_name || null]
                );
                accountId = accountResult.insertId;

            } else if (role === 'EMPLOYEE') {
                const [result] = await connection.execute(
                    `INSERT INTO AA_PRODUCER
                    (producer_email, producer_first_name, producer_last_name, producer_street, producer_city, producer_state, producer_zip_code, producer_country_id, producer_phone)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [email, first_name, last_name, street, city, state, zip_code, country_id, phone]
                );
                producerId = result.insertId;

            } else {
                throw new Error('Invalid registration role');
            }

            // 4. Create User Login
            await connection.execute(
                `INSERT INTO AA_USERS (email, password_hash, role, account_id, producer_id) 
                VALUES (?, ?, ?, ?, ?)`,
                [email, hashedPassword, role, accountId, producerId]
            );

        }, 'REPEATABLE READ');  // Use REPEATABLE READ isolation level

        res.status(201).json({ message: 'User registered successfully' });

    } catch (err) {
        console.error('Signup Error:', err);
        const code = err.message === 'Email already registered' ? 409 : 500;
        res.status(code).json({ error: err.message || 'Internal server error' });
    }
});

// Login Endpoint
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
    }

    try {
        const [rows] = await pool.execute(
            'SELECT user_id, email, password_hash, role, account_id, producer_id FROM AA_USERS WHERE email = ?',
            [email]
        );

        if (rows.length === 0) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const user = rows[0];
        const match = await bcrypt.compare(password, user.password_hash);

        if (!match) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        // Check account status for VIEWER role
        if (user.role === 'VIEWER' && user.account_id) {
            const [accountRows] = await pool.execute(
                'SELECT account_status FROM AA_VIEWER_ACCOUNT WHERE account_id = ?',
                [user.account_id]
            );

            if (accountRows.length > 0) {
                const accountStatus = accountRows[0].account_status;

                // Only LOCKED accounts are blocked from login
                if (accountStatus === 'LOCKED') {
                    return res.status(403).json({
                        error: 'Account is locked. Please contact support.',
                        status: 'LOCKED'
                    });
                }

                // FLAGGED accounts can login but will see a warning
                // The status is passed to frontend for banner display
            }
        }

        // Login successful - Return user info (excluding password)
        // Include account status for frontend to show warnings
        let accountStatus = 'ACTIVE';
        if (user.role === 'VIEWER' && user.account_id) {
            const [accountRows] = await pool.execute(
                'SELECT account_status FROM AA_VIEWER_ACCOUNT WHERE account_id = ?',
                [user.account_id]
            );
            if (accountRows.length > 0) {
                accountStatus = accountRows[0].account_status;
            }
        }

        res.json({
            message: 'Login successful',
            user: {
                id: user.user_id,
                email: user.email,
                role: user.role,
                accountId: user.account_id,
                producerId: user.producer_id,
                accountStatus: accountStatus // Include status for frontend
            }
        });

    } catch (err) {
        console.error('Login Error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// --- ANALYTICS ROUTES ---

// 1. Top 5 Web Series by Views
app.get('/api/analytics/top-series', async (req, res) => {
    try {
        const sql = `
            SELECT ws.series_name, COUNT(vh.view_id) as total_views
            FROM AA_WEB_SERIES ws
            JOIN AA_EPISODE ep ON ws.webseries_id = ep.webseries_id
            JOIN AA_VIEW_HISTORY vh ON ep.episode_id = vh.episode_id
            GROUP BY ws.series_name
            ORDER BY total_views DESC
            LIMIT 5
        `;
        const [rows] = await pool.execute(sql);
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// 2. Genre Distribution (Content Supply)
app.get('/api/analytics/genre-distribution', async (req, res) => {
    try {
        const sql = `
            SELECT g.genre_name, COUNT(wsg.webseries_id) as series_count
            FROM AA_GENRE g
            JOIN AA_WEBSERIES_GENRE wsg ON g.genre_id = wsg.genre_id
            GROUP BY g.genre_name
            ORDER BY series_count DESC
            LIMIT 10
        `;
        const [rows] = await pool.execute(sql);
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// --- REFERENCE DATA ROUTES ---

app.get('/api/genres', async (req, res) => {
    const [rows] = await pool.execute('SELECT * FROM AA_GENRE ORDER BY genre_name');
    res.json(rows);
});

app.get('/api/languages', async (req, res) => {
    const [rows] = await pool.execute('SELECT * FROM AA_LANGUAGE ORDER BY language_name');
    res.json(rows);
});

app.get('/api/countries', async (req, res) => {
    const [rows] = await pool.execute('SELECT * FROM AA_COUNTRY ORDER BY country_name');
    res.json(rows);
});

// --- CONTENT MANAGEMENT ROUTES (CRUD) ---

// 1. Get All Web Series (with Production House Name)
app.get('/api/series', async (req, res) => {
    try {
        const sql = `
            SELECT ws.webseries_id, ws.series_name, ph.ph_name, l.language_name, ws.release_date
            FROM AA_WEB_SERIES ws
            JOIN AA_PRODUCTION_HOUSE ph ON ws.production_house_id = ph.production_house_id
            JOIN AA_LANGUAGE l ON ws.original_language_id = l.language_id
            ORDER BY ws.release_date DESC
        `;
        const [rows] = await pool.execute(sql);
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// 2a. Comprehensive Create Series (Transaction)
app.post('/api/series/full', async (req, res) => {
    const {
        production_house_id, series_name, original_language_id, release_date,
        contract_date, charge_per_episode,
        genre_ids, // Array
        dubbing_language_ids, // Array
        release_country_ids // Array
    } = req.body;

    const connection = await pool.getConnection(); // Need dedicated connection for transaction

    try {
        await connection.beginTransaction();

        // 1. Insert Web Series
        const [seriesResult] = await connection.execute(
            'INSERT INTO AA_WEB_SERIES (production_house_id, series_name, original_language_id, release_date) VALUES (?, ?, ?, ?)',
            [production_house_id, series_name, original_language_id, release_date]
        );
        const newSeriesId = seriesResult.insertId;

        // 2. Insert Contract
        if (contract_date && charge_per_episode) {
            await connection.execute(
                'INSERT INTO AA_CONTRACT (webseries_id, contract_date, charge_per_episode) VALUES (?, ?, ?)',
                [newSeriesId, contract_date, charge_per_episode]
            );
        }

        // 3. Insert Genres
        if (genre_ids && genre_ids.length > 0) {
            const genreValues = genre_ids.map(id => [newSeriesId, id]);
            await connection.query('INSERT INTO AA_WEBSERIES_GENRE (webseries_id, genre_id) VALUES ?', [genreValues]);
        }

        // 4. Insert Dubbing Languages
        if (dubbing_language_ids && dubbing_language_ids.length > 0) {
            const dubValues = dubbing_language_ids.map(id => [newSeriesId, id]);
            await connection.query('INSERT INTO AA_WEBSERIES_DUBBING (webseries_id, language_id) VALUES ?', [dubValues]);
        }

        // 5. Insert Release Countries
        if (release_country_ids && release_country_ids.length > 0) {
            const countryValues = release_country_ids.map(id => [newSeriesId, id]);
            await connection.query('INSERT INTO AA_RELEASE_COUNTRY (webseries_id, country_id) VALUES ?', [countryValues]);
        }

        await connection.commit();
        res.json({ message: 'Series created successfully with all details!', id: newSeriesId });

    } catch (err) {
        await connection.rollback();
        console.error('Transaction Error:', err);
        res.status(500).json({ error: 'Failed to create series. Transaction rolled back.' });
    } finally {
        connection.release();
    }
});

// 2. Create Web Series (Simple)
app.post('/api/series', async (req, res) => {
    const { production_house_id, series_name, original_language_id, release_date } = req.body;
    try {
        await pool.execute(
            'INSERT INTO AA_WEB_SERIES (production_house_id, series_name, original_language_id, release_date) VALUES (?, ?, ?, ?)',
            [production_house_id, series_name, original_language_id, release_date]
        );
        res.json({ message: 'Series Created!' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// 3. Delete Web Series
app.delete('/api/series/:id', async (req, res) => {
    try {
        await pool.execute('DELETE FROM AA_WEB_SERIES WHERE webseries_id = ?', [req.params.id]);
        res.json({ message: 'Series Deleted!' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// 4. Get Episodes for a Series
app.get('/api/series/:id/episodes', async (req, res) => {
    try {
        const [rows] = await pool.execute(
            'SELECT * FROM AA_EPISODE WHERE webseries_id = ? ORDER BY episode_number',
            [req.params.id]
        );
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// 5. Create Episode
app.post('/api/episodes', async (req, res) => {
    const { webseries_id, episode_number, episode_title, duration_min } = req.body;
    try {
        await pool.execute(
            'INSERT INTO AA_EPISODE (webseries_id, episode_number, episode_title, duration_min) VALUES (?, ?, ?, ?)',
            [webseries_id, episode_number, episode_title, duration_min]
        );
        res.json({ message: 'Episode Created!' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// --- CONTRACT & PRODUCER ROUTES ---

// 1. Get All Production Houses
app.get('/api/production-houses', async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT * FROM AA_PRODUCTION_HOUSE ORDER BY ph_name');
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// 2. Get All Contracts
app.get('/api/contracts', async (req, res) => {
    try {
        const sql = `
            SELECT c.contract_id, c.webseries_id, ws.series_name, ph.ph_name, c.contract_date, c.charge_per_episode
            FROM AA_CONTRACT c
            JOIN AA_WEB_SERIES ws ON c.webseries_id = ws.webseries_id
            JOIN AA_PRODUCTION_HOUSE ph ON ws.production_house_id = ph.production_house_id
            ORDER BY c.contract_date DESC
        `;
        const [rows] = await pool.execute(sql);
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// 3. Renew Contract (Business Logic)
// "The contract is renewed each year... Netflix charges Production House per episode basis"
app.post('/api/contracts/renew', async (req, res) => {
    const { webseries_id, old_charge } = req.body;

    // Simple logic: Increase price by 5% for renewal or keep same
    const newCharge = parseFloat(old_charge) * 1.05;
    const nextYear = new Date(); // In real app, calculate based on previous end date

    try {
        await pool.execute(
            'INSERT INTO AA_CONTRACT (webseries_id, contract_date, charge_per_episode) VALUES (?, NOW(), ?)',
            [webseries_id, newCharge]
        );
        res.json({ message: `Contract Renewed! New Rate: $${newCharge.toFixed(2)}` });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// --- VIEWER ROUTES ---

// 1. Browse All Content (with Genre)
app.get('/api/browse', async (req, res) => {
    try {
        const sql = `
            SELECT 
                ws.webseries_id, 
                ws.series_name, 
                ws.release_date, 
                GROUP_CONCAT(DISTINCT g.genre_name SEPARATOR ', ') as genres,
                (SELECT episode_id FROM AA_EPISODE WHERE webseries_id = ws.webseries_id ORDER BY episode_number ASC LIMIT 1) as first_episode_id,
                -- Production House
                ph.ph_name as production_house,
                -- Languages
                GROUP_CONCAT(DISTINCT ld.language_code SEPARATOR ', ') as dubbed_langs,
                GROUP_CONCAT(DISTINCT ls.language_code SEPARATOR ', ') as sub_langs,
                -- Release Countries (IDs)
                GROUP_CONCAT(DISTINCT rc.country_id) as release_country_ids
            FROM AA_WEB_SERIES ws
            LEFT JOIN AA_PRODUCTION_HOUSE ph ON ws.production_house_id = ph.production_house_id
            LEFT JOIN AA_WEBSERIES_GENRE wsg ON ws.webseries_id = wsg.webseries_id
            LEFT JOIN AA_GENRE g ON wsg.genre_id = g.genre_id
            -- Dubbing
            LEFT JOIN AA_WEBSERIES_DUBBING wd ON ws.webseries_id = wd.webseries_id
            LEFT JOIN AA_LANGUAGE ld ON wd.language_id = ld.language_id
            -- Subtitles
            LEFT JOIN AA_WEBSERIES_SUBTITLE wst ON ws.webseries_id = wst.webseries_id
            LEFT JOIN AA_LANGUAGE ls ON wst.language_id = ls.language_id
            -- Release Country
            LEFT JOIN AA_RELEASE_COUNTRY rc ON ws.webseries_id = rc.webseries_id
            
            GROUP BY ws.webseries_id
            ORDER BY ws.release_date DESC
        `;
        const [rows] = await pool.execute(sql);
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// 2. Record View (Watch Episode)
app.post('/api/view', async (req, res) => {
    const { account_id, episode_id } = req.body;
    try {
        await pool.execute(
            'INSERT INTO AA_VIEW_HISTORY (account_id, episode_id, view_timestamp) VALUES (?, ?, NOW())',
            [account_id, episode_id]
        );
        res.json({ message: 'View Recorded' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// 3. Submit Feedback
app.post('/api/feedback', async (req, res) => {
    const { account_id, webseries_id, feedback_text, rating } = req.body;
    try {
        await pool.execute(
            'INSERT INTO AA_VIEWER_FEEDBACK (account_id, webseries_id, feedback_text, rating, feedback_date) VALUES (?, ?, ?, ?, NOW())',
            [account_id, webseries_id, feedback_text, rating]
        );
        res.json({ message: 'Feedback Submitted!' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// --- USER MANAGEMENT ROUTES ---

// 1. Get All Viewers (From AA_VIEWER_ACCOUNT, the source of truth)
app.get('/api/viewers', async (req, res) => {
    try {
        const sql = `
            SELECT va.*, u.email as login_email, u.user_id
            FROM AA_VIEWER_ACCOUNT va
            LEFT JOIN AA_USERS u ON va.account_id = u.account_id
            ORDER BY va.account_id ASC
        `;
        const [rows] = await pool.execute(sql);
        console.log('DEBUG /api/viewers Row 0:', rows.length > 0 ? rows[0] : 'No Data');
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// 2. Get Viewing History for a specific Account
app.get('/api/viewers/:id/history', async (req, res) => {
    const accountId = req.params.id; // Now receiving account_id
    try {
        const sql = `
            SELECT vh.view_timestamp, ws.series_name, ep.episode_title, ep.duration_min
            FROM AA_VIEW_HISTORY vh
            JOIN AA_EPISODE ep ON vh.episode_id = ep.episode_id
            JOIN AA_WEB_SERIES ws ON ep.webseries_id = ws.webseries_id
            WHERE vh.account_id = ?
            ORDER BY vh.view_timestamp DESC
        `;
        const [rows] = await pool.execute(sql, [accountId]);
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// --- PROFILE MANAGEMENT ROUTES ---

// 1. Get Profile (viewer_id or account_id passed via query or assumed from client context - 
// In a real app we'd use session/token, here we'll accept account_id in query for simplicity per previous patterns)
app.get('/api/profile/:id', async (req, res) => {
    const accountId = req.params.id;
    try {
        const sql = `
            SELECT va.*, c.country_name 
            FROM AA_VIEWER_ACCOUNT va
            JOIN AA_COUNTRY c ON va.viewer_country_id = c.country_id
            WHERE va.account_id = ?
        `;
        const [rows] = await pool.execute(sql, [accountId]);

        if (rows.length === 0) {
            return res.status(404).json({ error: 'Profile not found' });
        }
        res.json(rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// 2. Update Profile (Transaction)
app.put('/api/profile/:id', async (req, res) => {
    const accountId = req.params.id;
    const { viewer_street, viewer_city, viewer_state, viewer_zip_code } = req.body;

    // Start Transaction
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        // Update Address
        await connection.execute(
            `UPDATE AA_VIEWER_ACCOUNT 
             SET viewer_street = ?, viewer_city = ?, viewer_state = ?, viewer_zip_code = ?
             WHERE account_id = ?`,
            [viewer_street, viewer_city, viewer_state, viewer_zip_code, accountId]
        );

        await connection.commit();
        res.json({ message: 'Profile Updated Successfully!' });

    } catch (err) {
        await connection.rollback();
        console.error('Update Error:', err);
        res.status(500).json({ error: 'Update failed' });
    } finally {
        connection.release();
    }
});

// 3. Delete Account
app.delete('/api/profile/:id', async (req, res) => {
    const accountId = req.params.id;
    try {
        // AA_USERS, AA_VIEWER_FEEDBACK, AA_VIEW_HISTORY should cascade if configured. 
        // If AA_USERS doesn't cascade account_id, we might need to delete user first or let DB handle it.
        // Assuming DB constraints are set (ON DELETE CASCADE is standard for these relations).
        // Safest approach: Delete Viewer Account, let cascades handle the rest.

        // However, AA_USERS refers to AA_VIEWER_ACCOUNT. So deleting Viewer Account -> AA_USERS foreign key constraint?
        // AA_USERS has FK to VIEW_ACCOUNT. Usually needs CASCADE on the AA_USERS definition.

        await pool.execute('DELETE FROM AA_VIEWER_ACCOUNT WHERE account_id = ?', [accountId]);

        // Also cleanup AA_USERS just in case it wasn't cascaded perfectly (or if it was SET NULL)
        await pool.execute('DELETE FROM AA_USERS WHERE account_id = ?', [accountId]);

        res.json({ message: 'Account Closed. We will miss you!' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Deletion failed' });
    }
});


// --- WATCH HISTORY ROUTES ---

// 1. Get History (Joined)
app.get('/api/history/:accountId', async (req, res) => {
    const accountId = req.params.accountId;
    try {
        const sql = `
            SELECT 
                vh.view_id, 
                vh.view_timestamp, 
                e.episode_title, 
                e.episode_number, 
                ws.series_name,
                ws.webseries_id
            FROM AA_VIEW_HISTORY vh
            JOIN AA_EPISODE e ON vh.episode_id = e.episode_id
            JOIN AA_WEB_SERIES ws ON e.webseries_id = ws.webseries_id
            WHERE vh.account_id = ?
            ORDER BY vh.view_timestamp DESC
        `;
        const [rows] = await pool.execute(sql, [accountId]);
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// 2. Delete Single Item
app.delete('/api/history/item/:id', async (req, res) => {
    const viewId = req.params.id;
    try {
        await pool.execute('DELETE FROM AA_VIEW_HISTORY WHERE view_id = ?', [viewId]);
        res.json({ message: 'Item deleted' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Delete failed' });
    }
});

// 3. Delete All History (Transaction)
app.delete('/api/history/all/:accountId', async (req, res) => {
    const accountId = req.params.accountId;
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        await connection.execute('DELETE FROM AA_VIEW_HISTORY WHERE account_id = ?', [accountId]);

        await connection.commit();
        res.json({ message: 'History cleared successfully' });

    } catch (err) {
        await connection.rollback();
        console.error(err);
        res.status(500).json({ error: 'Clear history failed' });
    } finally {
        connection.release();
    }
});


// --- Country Management (Public & Admin) ---

// Public: Get List of Countries for Dropdown
app.get('/api/countries', async (req, res) => {
    try {
        // Exclude ID 999 (Other) from the main list if desired, or include it. 
        // We generally list real countries here. Frontend adds "Other".
        const [rows] = await pool.query('SELECT * FROM AA_COUNTRY WHERE country_id != 999 ORDER BY country_name ASC');
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Admin: Add Country
app.post('/api/admin/countries', async (req, res) => {
    const { country_name, country_code_iso } = req.body;
    try {
        // Find max ID excluding 999
        const [rows] = await pool.query('SELECT MAX(country_id) as maxId FROM AA_COUNTRY WHERE country_id < 999');
        const nextId = (rows[0].maxId || 0) + 1;

        await pool.query('INSERT INTO AA_COUNTRY (country_id, country_name, country_code_iso) VALUES (?, ?, ?)', [nextId, country_name, country_code_iso]);
        res.json({ message: 'Country added', countryId: nextId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Admin: Update Country
app.put('/api/admin/countries/:id', async (req, res) => {
    const { country_name, country_code_iso } = req.body;
    try {
        await pool.query('UPDATE AA_COUNTRY SET country_name = ?, country_code_iso = ? WHERE country_id = ?', [country_name, country_code_iso, req.params.id]);
        res.json({ message: 'Country updated' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Admin: Delete Country
app.delete('/api/admin/countries/:id', async (req, res) => {
    try {
        await pool.execute('DELETE FROM AA_COUNTRY WHERE country_id = ?', [req.params.id]);
        res.json({ message: 'Country deleted' });
    } catch (err) {
        res.status(500).json({ error: err.message }); // Will fail if FK constraints exist (which is good)
    }
});

// Admin: Get Suggestions
app.get('/api/admin/suggestions', async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT suggested_country_name, COUNT(*) as user_count 
            FROM AA_VIEWER_ACCOUNT 
            WHERE viewer_country_id = 999 
            AND suggested_country_name IS NOT NULL 
            GROUP BY suggested_country_name
        `);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Admin: Approve Country (Transaction)
app.post('/api/admin/approve-country', async (req, res) => {
    // Sanitize country names to prevent XSS
    const sanitized = sanitizeInput(req.body);
    const { suggested_name, official_name, official_code } = sanitized;

    try {
        const result = await executeWithTransaction(async (connection) => {
            // 1. Calculate Next ID with FOR UPDATE lock (Gap Filling Logic)
            // Lock the max ID row to prevent concurrent ID conflicts
            const [rows] = await connection.query(
                'SELECT MAX(country_id) as maxId FROM AA_COUNTRY WHERE country_id < 999 FOR UPDATE'
            );
            const nextId = (rows[0].maxId || 0) + 1;

            // 2. Create Official Country with explicit ID
            await connection.execute(
                'INSERT INTO AA_COUNTRY (country_id, country_name, country_code_iso) VALUES (?, ?, ?)',
                [nextId, official_name, official_code]
            );

            // 3. Update Users who suggested this name
            const [updateRes] = await connection.execute(
                `UPDATE AA_VIEWER_ACCOUNT 
                 SET viewer_country_id = ?, suggested_country_name = NULL 
                 WHERE viewer_country_id = 999 AND suggested_country_name = ?`,
                [nextId, suggested_name]
            );

            return {
                newCountryId: nextId,
                usersUpdated: updateRes.affectedRows
            };

        }, 'SERIALIZABLE');  // Use SERIALIZABLE for maximum isolation

        res.json({
            message: 'Country Approved',
            ...result
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- User Management (Admin) ---

// Admin: Get Viewers with Filters
app.get('/api/admin/viewers', async (req, res) => {
    const { email, country_id, min_charge, max_charge, status } = req.query;

    try {
        let query = `
            SELECT 
                v.account_id,
                v.viewer_email,
                v.viewer_first_name,
                v.viewer_last_name,
                v.monthly_service_charge,
                v.account_status,
                v.viewer_country_id,
                c.country_name
            FROM AA_VIEWER_ACCOUNT v
            LEFT JOIN AA_COUNTRY c ON v.viewer_country_id = c.country_id
            WHERE 1=1
        `;

        const params = [];

        if (email) {
            query += ' AND v.viewer_email LIKE ?';
            params.push(`%${email}%`);
        }

        if (country_id) {
            query += ' AND v.viewer_country_id = ?';
            params.push(country_id);
        }

        if (min_charge) {
            query += ' AND v.monthly_service_charge >= ?';
            params.push(parseFloat(min_charge));
        }

        if (max_charge) {
            query += ' AND v.monthly_service_charge <= ?';
            params.push(parseFloat(max_charge));
        }

        if (status) {
            query += ' AND v.account_status = ?';
            params.push(status);
        }

        query += ' ORDER BY v.account_id DESC';

        const [rows] = await pool.query(query, params);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Admin: Update Service Charge
app.put('/api/admin/viewers/:accountId/charge', async (req, res) => {
    const { accountId } = req.params;
    const { monthly_service_charge } = req.body;

    if (monthly_service_charge < 0) {
        return res.status(400).json({ error: 'Charge must be non-negative' });
    }

    try {
        await executeWithTransaction(async (connection) => {
            // Lock the account row to prevent concurrent updates
            await connection.execute(
                'SELECT account_id FROM AA_VIEWER_ACCOUNT WHERE account_id = ? FOR UPDATE',
                [accountId]
            );

            // Update the charge
            await connection.execute(
                'UPDATE AA_VIEWER_ACCOUNT SET monthly_service_charge = ? WHERE account_id = ?',
                [monthly_service_charge, accountId]
            );
        }, 'REPEATABLE READ');

        res.json({ message: 'Service charge updated' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Admin: Update Account Status
app.put('/api/admin/viewers/:accountId/status', async (req, res) => {
    const { accountId } = req.params;
    const { account_status } = req.body;

    const validStatuses = ['ACTIVE', 'LOCKED', 'FLAGGED'];
    if (!validStatuses.includes(account_status)) {
        return res.status(400).json({ error: 'Invalid status' });
    }

    try {
        await pool.execute(
            'UPDATE AA_VIEWER_ACCOUNT SET account_status = ? WHERE account_id = ?',
            [account_status, accountId]
        );
        res.json({ message: 'Account status updated' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Production House Management (Admin) ---

// Get Production Houses with Search
app.get('/api/admin/production-houses', async (req, res) => {
    const { name } = req.query;

    try {
        let query = `
            SELECT 
                ph.production_house_id,
                ph.ph_name,
                ph.ph_city,
                ph.ph_country_id,
                c.country_name,
                ph.year_established,
                COUNT(DISTINCT ws.webseries_id) as series_count
            FROM AA_PRODUCTION_HOUSE ph
            LEFT JOIN AA_COUNTRY c ON ph.ph_country_id = c.country_id
            LEFT JOIN AA_WEB_SERIES ws ON ph.production_house_id = ws.production_house_id
            WHERE 1=1
        `;

        const params = [];

        if (name) {
            query += ' AND ph.ph_name LIKE ?';
            params.push(`%${name}%`);
        }

        query += ' GROUP BY ph.production_house_id ORDER BY ph.ph_name ASC';

        const [rows] = await pool.query(query, params);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get Single Production House
app.get('/api/admin/production-houses/:id', async (req, res) => {
    const { id } = req.params;

    try {
        const [rows] = await pool.query(
            'SELECT * FROM AA_PRODUCTION_HOUSE WHERE production_house_id = ?',
            [id]
        );

        if (rows.length === 0) {
            return res.status(404).json({ error: 'Production house not found' });
        }

        res.json(rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Add Production House
app.post('/api/admin/production-houses', async (req, res) => {
    // Sanitize production house data to prevent XSS
    const sanitized = sanitizeInput(req.body);
    const { ph_name, ph_street, ph_city, ph_state, ph_zip_code, ph_country_id, year_established } = sanitized;

    try {
        const [result] = await pool.execute(
            `INSERT INTO AA_PRODUCTION_HOUSE 
            (ph_name, ph_street, ph_city, ph_state, ph_zip_code, ph_country_id, year_established) 
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [ph_name, ph_street, ph_city, ph_state || null, ph_zip_code, ph_country_id, year_established]
        );
        res.json({ message: 'Production house added', id: result.insertId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Update Production House
app.put('/api/admin/production-houses/:id', async (req, res) => {
    const { id } = req.params;
    // Sanitize production house data to prevent XSS
    const sanitized = sanitizeInput(req.body);
    const { ph_name, ph_street, ph_city, ph_state, ph_zip_code, ph_country_id, year_established } = sanitized;

    try {
        await pool.execute(
            `UPDATE AA_PRODUCTION_HOUSE 
            SET ph_name = ?, ph_street = ?, ph_city = ?, ph_state = ?, 
                ph_zip_code = ?, ph_country_id = ?, year_established = ?
            WHERE production_house_id = ?`,
            [ph_name, ph_street, ph_city, ph_state || null, ph_zip_code, ph_country_id, year_established, id]
        );
        res.json({ message: 'Production house updated' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Delete Production House
app.delete('/api/admin/production-houses/:id', async (req, res) => {
    const { id } = req.params;

    try {
        await pool.execute('DELETE FROM AA_PRODUCTION_HOUSE WHERE production_house_id = ?', [id]);
        res.json({ message: 'Production house deleted' });
    } catch (err) {
        // Will fail if there are web series linked to this production house (FK constraint)
        res.status(500).json({ error: err.message });
    }
});

// Start Server
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
});

module.exports = { app, pool };
