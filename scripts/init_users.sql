-- Create AA_USERS table for Authentication
-- Updated to strictly link to existing Viewer and Producer tables via Foreign Keys

CREATE TABLE IF NOT EXISTS AA_USERS (
    user_id INT AUTO_INCREMENT PRIMARY KEY,
    email VARCHAR(100) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    role ENUM('ADMIN', 'PRODUCER', 'VIEWER') NOT NULL,
    
    -- Foreign Keys to link to specific entity tables
    -- Only one of these should be set (or neither for pure Admins)
    account_id INT, 
    producer_id INT,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    -- Explicit Referencing for Data Integrity
    CONSTRAINT fk_users_viewer FOREIGN KEY (account_id) REFERENCES AA_VIEWER_ACCOUNT(account_id) ON DELETE CASCADE,
    CONSTRAINT fk_users_producer FOREIGN KEY (producer_id) REFERENCES AA_PRODUCER(producer_id) ON DELETE SET NULL
);

-- Index for fast login lookups
CREATE INDEX idx_users_email ON AA_USERS(email);
