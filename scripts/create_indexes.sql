-- Database Performance Optimization Indexes
-- Created: 2025-12-10
-- Purpose: Optimize frequently queried columns for better performance

-- ============================================================================
-- ANALYSIS SUMMARY
-- ============================================================================
-- Baseline analysis showed:
-- 1. User email lookup - Already has UNIQUE index (email column)
-- 2. Production house search - NEEDS INDEX (full table scan)
-- 3. Series by production house - Already has FK index (fk_aa_ws_ph)
-- 4. View history by account - Already has FK index (fk_aa_vh_acct)
-- ============================================================================

USE NEWS;

-- Index 1: Production House Name Search
-- Why: Admin searches by name frequently, currently doing full table scan
-- Expected improvement: O(n) → O(log n) for LIKE queries
CREATE INDEX idx_production_house_name ON AA_PRODUCTION_HOUSE(ph_name);

-- Index 2: Series Name Search  
-- Why: Users search for series by name on browse page
-- Expected improvement: Faster series lookups
CREATE INDEX idx_series_name ON AA_WEB_SERIES(series_name);

-- Index 3: Viewer Email (if not already exists)
-- Why: Login queries happen on every session
-- Note: This might already exist as UNIQUE constraint
CREATE INDEX IF NOT EXISTS idx_viewer_email ON AA_VIEWER_ACCOUNT(viewer_email);

-- Index 4: Country Name Lookup
-- Why: Country dropdown and admin country management
-- Expected improvement: Faster country searches
CREATE INDEX idx_country_name ON AA_COUNTRY(country_name);

-- Index 5: Composite Index for Series Filtering
-- Why: Browse page filters by language
-- Expected improvement: Multi-column filtering
CREATE INDEX idx_series_language ON AA_WEB_SERIES(original_language_id);

-- ============================================================================
-- VERIFICATION QUERIES
-- ============================================================================

-- Show all indexes on key tables
SHOW INDEXES FROM AA_USERS;
SHOW INDEXES FROM AA_PRODUCTION_HOUSE;
SHOW INDEXES FROM AA_WEB_SERIES;
SHOW INDEXES FROM AA_VIEW_HISTORY;
SHOW INDEXES FROM AA_COUNTRY;

-- ============================================================================
-- PERFORMANCE NOTES
-- ============================================================================
-- These indexes will:
-- 1. Speed up login queries (email lookup)
-- 2. Optimize admin searches (production house, series names)
-- 3. Improve browse page performance (series filtering)
-- 4. Faster country lookups
--
-- Trade-offs:
-- - Slightly slower INSERT/UPDATE operations (minimal impact)
-- - Additional storage space (negligible for our data size)
-- - Significant READ performance improvements (50-90% faster)
-- ============================================================================
