# Cross-Site Scripting (XSS) Prevention Documentation

## Overview

This document explains how Cross-Site Scripting (XSS) attacks are prevented in the Netflix MySQL Web Application to protect users from malicious JavaScript injection.

---

## What is Cross-Site Scripting (XSS)?

**XSS** is a security vulnerability where attackers inject malicious JavaScript code through user input fields. This code then executes in other users' browsers, potentially:
- Stealing session cookies
- Redirecting to phishing sites
- Modifying page content
- Performing unauthorized actions

### Example Attack

**Attacker signs up with malicious name:**
```javascript
First Name: <script>alert('Hacked!')</script>
```

**Without protection:**
```javascript
// Vulnerable code
element.innerHTML = user.first_name;
// Result: Alert popup appears! 💥
```

**With protection:**
```javascript
// Safe code
element.textContent = user.first_name;
// Result: Displays as text: <script>alert('Hacked!')</script>
```

---

## Our XSS Prevention Strategy

### Defense in Depth (2 Layers)

#### Layer 1: Backend Sanitization (Primary Defense)
Sanitize all user input before storing in database

#### Layer 2: Frontend Safe Rendering (Secondary Defense)
Use safe methods to display user data

---

## Implementation

### 1. Backend Protection (server.js)

**Library Used:** `xss` npm package

**Sanitization Function:**
```javascript
const xss = require('xss');

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
            // Keep non-string values as-is
            sanitized[key] = obj[key];
        }
    }
    return sanitized;
}
```

**How it works:**
```javascript
xss('<script>alert("XSS")</script>')
// Returns: '&lt;script&gt;alert("XSS")&lt;/script&gt;'

xss('<img src=x onerror=alert(1)>')
// Returns: '&lt;img src=x onerror=alert(1)&gt;'

xss('Normal text')
// Returns: 'Normal text' (unchanged)
```

---

### 2. Protected Endpoints

All endpoints that accept user input are protected:

#### User Registration
```javascript
app.post('/api/signup', async (req, res) => {
    // Sanitize all user inputs
    const sanitized = sanitizeInput(req.body);
    const { first_name, last_name, email, ... } = sanitized;
    // Now safe to use!
});
```

**Protected fields:**
- First name, last name
- Email
- Street, city, state
- Suggested country name
- Phone number

#### Country Management
```javascript
app.post('/api/admin/approve-country', async (req, res) => {
    const sanitized = sanitizeInput(req.body);
    const { suggested_name, official_name, official_code } = sanitized;
    // Safe country names
});
```

**Protected fields:**
- Suggested country name
- Official country name
- Country code

#### Production House Management
```javascript
app.post('/api/admin/production-houses', async (req, res) => {
    const sanitized = sanitizeInput(req.body);
    const { ph_name, ph_street, ph_city, ... } = sanitized;
    // Safe production house data
});
```

**Protected fields:**
- Production house name
- Address fields (street, city, state)

---

## Testing XSS Prevention

### Test 1: Malicious Signup

**Steps:**
1. Go to `http://localhost:3000/signup.html`
2. Enter malicious data:
   ```
   First Name: <script>alert('XSS')</script>
   Last Name: <img src=x onerror=alert('Hacked')>
   ```
3. Complete signup
4. Login as admin
5. View user in "Manage Viewers"

**Expected Result:**
- ✅ Name displays as escaped text
- ✅ No JavaScript execution
- ✅ No alert popups

**Database Storage:**
```sql
SELECT viewer_first_name FROM AA_VIEWER_ACCOUNT;
-- Result: &lt;script&gt;alert('XSS')&lt;/script&gt;
```

---

### Test 2: Production House XSS

**Steps:**
1. Login as admin
2. Add production house with name: `<script>document.body.innerHTML='HACKED'</script>`
3. Save and refresh page

**Expected Result:**
- ✅ Name shows as text
- ✅ Page remains unchanged
- ✅ No script execution

---

### Test 3: Country Name XSS

**Steps:**
1. Sign up with country = "Other/Unknown"
2. Suggested name: `<img src=x onerror=alert('Country XSS')>`
3. Admin approves country
4. View in country list

**Expected Result:**
- ✅ Country name sanitized
- ✅ No image error
- ✅ No alert

---

## Common XSS Attack Vectors (All Blocked)

| Attack Vector | Example | Our Protection |
|---------------|---------|----------------|
| Script tags | `<script>alert(1)</script>` | Escaped to `&lt;script&gt;` |
| Event handlers | `<img onerror=alert(1)>` | Escaped |
| JavaScript URLs | `<a href="javascript:alert(1)">` | Escaped |
| Data URIs | `<img src="data:text/html,<script>alert(1)</script>">` | Escaped |
| SVG scripts | `<svg onload=alert(1)>` | Escaped |

---

## Security Best Practices Followed

1. ✅ **Input Sanitization**: All user input sanitized on backend
2. ✅ **Output Encoding**: Data escaped before display
3. ✅ **Defense in Depth**: Multiple layers of protection
4. ✅ **Whitelist Approach**: Only safe HTML allowed
5. ✅ **Consistent Application**: All endpoints protected

---

## Frontend Safe Rendering (Bonus Protection)

While backend sanitization is primary defense, frontend also uses safe methods:

**Safe:**
```javascript
element.textContent = userData;  // ✅ Always safe
```

**Unsafe (avoided):**
```javascript
element.innerHTML = userData;  // ❌ Can execute scripts
```

---

## Monitoring and Maintenance

### Regular Security Checks
- Review all new endpoints for XSS protection
- Update `xss` library regularly: `npm update xss`
- Test with OWASP XSS cheat sheet

### Logging
Sanitization happens silently, but you can add logging:
```javascript
function sanitizeInput(obj) {
    const sanitized = {};
    for (let key in obj) {
        if (typeof obj[key] === 'string') {
            const cleaned = xss(obj[key]);
            if (cleaned !== obj[key]) {
                console.log(`⚠️ XSS attempt blocked in field: ${key}`);
            }
            sanitized[key] = cleaned;
        }
        // ...
    }
    return sanitized;
}
```

---

## Summary

Our XSS prevention ensures:
- ✅ **No Script Execution**: Malicious JavaScript cannot run
- ✅ **Data Integrity**: User data stored safely
- ✅ **User Protection**: All users protected from XSS attacks
- ✅ **Comprehensive Coverage**: All input fields protected

**Project Requirement Met**: ✅ Cross-site scripting attack prevention implemented

---

## References

- [OWASP XSS Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html)
- [xss npm package](https://www.npmjs.com/package/xss)
- [MDN: XSS](https://developer.mozilla.org/en-US/docs/Glossary/Cross-site_scripting)
