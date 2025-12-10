# Concurrent Transaction Handling Documentation

## Overview

This document explains how concurrent transactions are handled in the Netflix MySQL Web Application to prevent data corruption, race conditions, and deadlocks when multiple users access the system simultaneously.

## Implementation

### 1. Transaction Helper Utility

**Location**: `server.js` (lines 51-113)

**Function**: `executeWithTransaction(operation, isolationLevel, maxRetries)`

**Features**:
- Automatic deadlock detection and retry
- Configurable isolation levels
- Exponential backoff for retries
- Automatic rollback on errors
- Connection management

**Parameters**:
- `operation`: Async function that performs database operations
- `isolationLevel`: Transaction isolation level (default: REPEATABLE READ)
- `maxRetries`: Maximum retry attempts for deadlocks (default: 3)

### 2. Isolation Levels Used

#### REPEATABLE READ (Default)
- **Used in**: Signup, Service Charge Updates
- **Prevents**: Dirty reads, non-repeatable reads
- **Allows**: Phantom reads (acceptable for these operations)

#### SERIALIZABLE
- **Used in**: Country Approval
- **Prevents**: All concurrency issues (dirty reads, non-repeatable reads, phantom reads)
- **Why**: Critical for sequential ID generation

### 3. Pessimistic Locking (FOR UPDATE)

Locks rows during SELECT to prevent concurrent modifications.

## Critical Operations

### Operation 1: User Signup

**Endpoint**: `POST /api/signup`

**Concurrency Issues Prevented**:
- ✅ Duplicate email registration
- ✅ Race conditions in account creation

**Implementation**:
```javascript
await executeWithTransaction(async (connection) => {
    // Lock email check to prevent concurrent signups
    const [existing] = await connection.execute(
        'SELECT user_id FROM AA_USERS WHERE email = ? FOR UPDATE',
        [email]
    );
    
    if (existing.length > 0) {
        throw new Error('Email already registered');
    }
    
    // Create account and user...
}, 'REPEATABLE READ');
```

**Test Scenario**: 10 users try to sign up with same email simultaneously
- **Expected**: Only 1 succeeds, 9 get "Email already registered"

---

### Operation 2: Country Approval

**Endpoint**: `POST /api/admin/approve-country`

**Concurrency Issues Prevented**:
- ✅ Duplicate country IDs
- ✅ ID conflicts in gap-filling logic
- ✅ Lost updates

**Implementation**:
```javascript
await executeWithTransaction(async (connection) => {
    // Lock MAX(country_id) to prevent concurrent ID conflicts
    const [rows] = await connection.query(
        'SELECT MAX(country_id) as maxId FROM AA_COUNTRY WHERE country_id < 999 FOR UPDATE'
    );
    const nextId = (rows[0].maxId || 0) + 1;
    
    // Insert with calculated ID...
}, 'SERIALIZABLE');
```

**Test Scenario**: 5 admins approve different countries simultaneously
- **Expected**: All get unique sequential IDs (no conflicts)

---

### Operation 3: Service Charge Update

**Endpoint**: `PUT /api/admin/viewers/:accountId/charge`

**Concurrency Issues Prevented**:
- ✅ Lost updates (last write wins problem)
- ✅ Concurrent modification conflicts

**Implementation**:
```javascript
await executeWithTransaction(async (connection) => {
    // Lock account row
    await connection.execute(
        'SELECT account_id FROM AA_VIEWER_ACCOUNT WHERE account_id = ? FOR UPDATE',
        [accountId]
    );
    
    // Update charge...
}, 'REPEATABLE READ');
```

**Test Scenario**: 5 admins update same account's charge simultaneously
- **Expected**: All updates succeed sequentially, final value is last update

---

## Deadlock Handling

### What is a Deadlock?

Two transactions waiting for each other to release locks:
- Transaction A: Locks Row 1, waits for Row 2
- Transaction B: Locks Row 2, waits for Row 1
- **Result**: Both stuck forever

### How We Handle It

1. **Detection**: MySQL automatically detects deadlocks
2. **Error Code**: `ER_LOCK_DEADLOCK`
3. **Retry Logic**: Automatic retry with exponential backoff
4. **Max Retries**: 3 attempts before giving up

**Example Log**:
```
⚠️ Deadlock detected, retrying... (1/3)
⚠️ Deadlock detected, retrying... (2/3)
✅ Transaction succeeded on retry 3
```

---

## Testing

### Test Scripts Location
`/scripts/test_concurrent_*.js`

### Test 1: Concurrent Signups
```bash
node scripts/test_concurrent_signup.js
```
- Simulates 10 simultaneous signups
- Verifies email uniqueness
- Checks for deadlocks

### Test 2: Concurrent Country Approvals
```bash
node scripts/test_concurrent_country_approval.js
```
- Simulates 5 simultaneous approvals
- Verifies unique ID generation
- Tests SERIALIZABLE isolation

### Test 3: Concurrent Charge Updates
```bash
node scripts/test_concurrent_charge_update.js
```
- Simulates 5 simultaneous updates on same account
- Verifies no lost updates
- Tests FOR UPDATE locking

### Test 4: Deadlock Detection
```bash
node scripts/test_deadlock.js
```
- Forces a deadlock scenario
- Verifies automatic retry
- Confirms both transactions eventually succeed

---

## Performance Considerations

### Locking Overhead
- **FOR UPDATE** locks rows until transaction commits
- **Trade-off**: Correctness vs. throughput
- **Mitigation**: Keep transactions short

### Isolation Level Impact
- **SERIALIZABLE**: Highest safety, lowest concurrency
- **REPEATABLE READ**: Good balance for most operations
- **READ COMMITTED**: Fastest, but allows non-repeatable reads

### Retry Backoff
- **Exponential backoff**: 100ms, 200ms, 300ms
- **Prevents**: Retry storms
- **Allows**: Deadlocks to resolve naturally

---

## Best Practices

1. ✅ **Always use transactions for multi-step operations**
2. ✅ **Use FOR UPDATE when reading data you'll modify**
3. ✅ **Keep transactions as short as possible**
4. ✅ **Use appropriate isolation levels**
5. ✅ **Handle deadlocks with retry logic**
6. ✅ **Log deadlock occurrences for monitoring**

---

## Monitoring

### Metrics to Track
- Deadlock frequency
- Retry success rate
- Transaction duration
- Lock wait times

### MySQL Commands
```sql
-- Show current transactions
SHOW ENGINE INNODB STATUS;

-- Check for locks
SELECT * FROM information_schema.INNODB_LOCKS;

-- Check for lock waits
SELECT * FROM information_schema.INNODB_LOCK_WAITS;
```

---

## Future Improvements

1. **Optimistic Locking**: Use version numbers for less critical updates
2. **Read Replicas**: Offload read queries to reduce contention
3. **Caching**: Cache frequently read data (countries, genres)
4. **Queue System**: Batch non-urgent operations
5. **Monitoring Dashboard**: Real-time deadlock tracking

---

## Summary

Our concurrent transaction handling ensures:
- ✅ **Data Integrity**: No duplicate IDs, emails, or lost updates
- ✅ **Consistency**: All transactions see consistent data
- ✅ **Reliability**: Automatic deadlock recovery
- ✅ **Scalability**: Handles multiple concurrent users

**Project Requirement Met**: ✅ Transaction concurrency and deadlock prevention implemented
