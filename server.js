require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const mysql = require('mysql2/promise');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public')); // Serve frontend files

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

// --- MIDDLEWARE ---

// Middleware to get user from header (Simple Auth)
const getUser = async (req, res, next) => {
    const userId = req.headers['x-user-id'];
    if (!userId) {
        req.user = null;
        return next();
    }

    try {
        const [rows] = await pool.execute(
            'SELECT user_id, email, role, account_id, producer_id FROM AA_USERS WHERE user_id = ?',
            [userId]
        );
        req.user = rows[0] || null;
    } catch (err) {
        console.error('Auth Middleware Error:', err);
        req.user = null;
    }
    next();
};

app.use(getUser);

// --- API ROUTES ---

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

        // Login successful - Return user info (excluding password)
        res.json({
            message: 'Login successful',
            user: {
                id: user.user_id,
                email: user.email,
                role: user.role,
                accountId: user.account_id,
                producerId: user.producer_id
            }
        });

    } catch (err) {
        console.error('Login Error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// --- ANALYTICS ROUTES ---

// 1. Top 5 Web Series by Views (Accessible to All or restricted?)
// "Producer... can see raw aggregated data"
app.get('/api/analytics/top-series', async (req, res) => {
    if (!req.user || (req.user.role !== 'ADMIN' && req.user.role !== 'PRODUCER')) {
        // Viewers can see basic info? Let's allow generic top 5 for everyone as it's not sensitive?
        // Requirement says Producer "can only see raw aggregated view data".
        // Viewer "can view basic information... list of shows... but not contract details".
        // I'll allow Viewers to see top series as part of "list of shows" / browsing.
    }

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
            SELECT ws.webseries_id, ws.series_name, ph.ph_name, l.language_name, ws.release_date, ws.production_house_id
            FROM AA_WEB_SERIES ws
            JOIN AA_PRODUCTION_HOUSE ph ON ws.production_house_id = ph.production_house_id
            JOIN AA_LANGUAGE l ON ws.original_language_id = l.language_id
            ORDER BY ws.release_date DESC
        `;
        const [rows] = await pool.execute(sql);

        // Ensure contract details are not exposed here (they aren't in this SQL).
        // If Producer, we could return all to browse, but UI handles management buttons.
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// 2a. Comprehensive Create Series (Transaction)
app.post('/api/series/full', async (req, res) => {
    if (!req.user || (req.user.role !== 'ADMIN' && req.user.role !== 'PRODUCER')) {
        return res.status(403).json({ error: 'Access denied' });
    }

    const {
        production_house_id, series_name, original_language_id, release_date,
        contract_date, charge_per_episode,
        genre_ids, // Array
        dubbing_language_ids, // Array
        release_country_ids // Array
    } = req.body;

    // Validate Producer Access
    if (req.user.role === 'PRODUCER' && req.user.producer_id !== parseInt(production_house_id)) {
        return res.status(403).json({ error: 'You can only produce series for your Production House.' });
    }

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
    // Deprecated or same checks as full
    if (!req.user || (req.user.role !== 'ADMIN' && req.user.role !== 'PRODUCER')) {
        return res.status(403).json({ error: 'Access denied' });
    }
    const { production_house_id, series_name, original_language_id, release_date } = req.body;

    if (req.user.role === 'PRODUCER' && req.user.producer_id !== parseInt(production_house_id)) {
        return res.status(403).json({ error: 'Unauthorized Production House' });
    }

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
    if (!req.user || (req.user.role !== 'ADMIN' && req.user.role !== 'PRODUCER')) {
        return res.status(403).json({ error: 'Access denied' });
    }
    try {
        // If Producer, verify ownership
        if (req.user.role === 'PRODUCER') {
            const [rows] = await pool.execute('SELECT production_house_id FROM AA_WEB_SERIES WHERE webseries_id = ?', [req.params.id]);
            if (rows.length === 0 || rows[0].production_house_id !== req.user.producer_id) {
                return res.status(403).json({ error: 'You can only delete your own series.' });
            }
        }

        await pool.execute('DELETE FROM AA_WEB_SERIES WHERE webseries_id = ?', [req.params.id]);
        res.json({ message: 'Series Deleted!' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// 4. Get Episodes for a Series (Viewable by all)
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
    if (!req.user || (req.user.role !== 'ADMIN' && req.user.role !== 'PRODUCER')) {
        return res.status(403).json({ error: 'Access denied' });
    }
    const { webseries_id, episode_number, episode_title, duration_min } = req.body;

    // Check ownership
    if (req.user.role === 'PRODUCER') {
        const [rows] = await pool.execute('SELECT production_house_id FROM AA_WEB_SERIES WHERE webseries_id = ?', [webseries_id]);
        if (rows.length === 0 || rows[0].production_house_id !== req.user.producer_id) {
            return res.status(403).json({ error: 'Unauthorized' });
        }
    }

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

// 2. Get All Contracts (Protected)
app.get('/api/contracts', async (req, res) => {
    if (!req.user || (req.user.role !== 'ADMIN' && req.user.role !== 'PRODUCER')) {
        return res.status(403).json({ error: 'Access denied' });
    }

    try {
        let sql = `
            SELECT c.contract_id, c.webseries_id, ws.series_name, ph.ph_name, c.contract_date, c.charge_per_episode
            FROM AA_CONTRACT c
            JOIN AA_WEB_SERIES ws ON c.webseries_id = ws.webseries_id
            JOIN AA_PRODUCTION_HOUSE ph ON ws.production_house_id = ph.production_house_id
        `;
        const params = [];

        if (req.user.role === 'PRODUCER') {
            sql += ` WHERE ph.production_house_id = ? `;
            params.push(req.user.producer_id);
        }

        sql += ` ORDER BY c.contract_date DESC`;

        const [rows] = await pool.execute(sql, params);
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// 3. Renew Contract (Business Logic)
// "The contract is renewed each year... Netflix charges Production House per episode basis"
app.post('/api/contracts/renew', async (req, res) => {
    // Only Admin can renew? Or Producer too? Assuming Admin mostly, but let's allow Producer if logic allows.
    // Actually renewal involves "Netflix charges Production House". Usually Admin initiates. 
    // But let's restrict to Admin for now, or Producer if they initiate it.
    if (!req.user || req.user.role !== 'ADMIN') {
        return res.status(403).json({ error: 'Only Admins can renew contracts' });
    }

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
    // Public? or Viewer/All? Public seems fine.
    try {
        const sql = `
            SELECT ws.webseries_id, ws.series_name, ws.release_date, 
                   GROUP_CONCAT(g.genre_name SEPARATOR ', ') as genres
            FROM AA_WEB_SERIES ws
            LEFT JOIN AA_WEBSERIES_GENRE wsg ON ws.webseries_id = wsg.webseries_id
            LEFT JOIN AA_GENRE g ON wsg.genre_id = g.genre_id
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
    // Should verify req.user.role === 'VIEWER' and account_id matches?
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
    // Similar verification could go here
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
    if (!req.user || req.user.role !== 'ADMIN') {
        return res.status(403).json({ error: 'Access denied' });
    }
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
    const accountId = req.params.id;
    // Allow Admin, or the Viewer themselves
    if (!req.user) return res.status(403).json({ error: 'Access Denied' });
    if (req.user.role !== 'ADMIN') {
        // Fix: req.user comes from DB select, so use snake_case 'account_id'
        if (req.user.role === 'VIEWER' && req.user.account_id != accountId) {
            return res.status(403).json({ error: 'Access denied' });
        }
        if (req.user.role === 'PRODUCER') {
            // Producer can see aggregated data, maybe not individual history?
            // "customers can only see the raw aggregated view data"
            // So Deny individual history
            return res.status(403).json({ error: 'Access denied' });
        }
    }

    try {
        const sql = `
            SELECT vh.view_id, vh.view_timestamp, ws.series_name, ep.episode_title, ep.duration_min
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

// 3. Delete View History Item
app.delete('/api/viewers/:id/history/:viewId', async (req, res) => {
    const accountId = req.params.id;
    const viewId = req.params.viewId;

    if (!req.user) return res.status(403).json({ error: 'Access Denied' });

    // Authorization
    if (req.user.role !== 'ADMIN') {
        if (req.user.role === 'VIEWER' && req.user.account_id != accountId) {
            return res.status(403).json({ error: 'Access denied' });
        }
        if (req.user.role === 'PRODUCER') return res.status(403).json({ error: 'Access denied' });
    }

    try {
        // Enforce account_id check to prevent deleting others' history by randomly guessing viewId (if global)
        // although view_id is unique, good practice to limit scope.
        const [result] = await pool.execute(
            'DELETE FROM AA_VIEW_HISTORY WHERE view_id = ? AND account_id = ?',
            [viewId, accountId]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'History item not found' });
        }

        res.json({ message: 'History deleted' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// Start Server
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
});

module.exports = { app, pool };
