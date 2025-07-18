const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// In-memory user store (in production, use a database)
const users = new Map();

// Initialize with admin user from environment
async function initializeUsers() {
    const adminUsername = process.env.ADMIN_USERNAME || 'admin';
    const adminPassword = process.env.ADMIN_PASSWORD || 'changeme123';
    
    const hashedPassword = await bcrypt.hash(adminPassword, 10);
    users.set(adminUsername, {
        username: adminUsername,
        password: hashedPassword,
        role: 'admin'
    });
}

// Authenticate user
async function authenticateUser(username, password) {
    const user = users.get(username);
    if (!user) {
        return null;
    }
    
    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) {
        return null;
    }
    
    return {
        username: user.username,
        role: user.role
    };
}

// Generate JWT token
function generateToken(user) {
    return jwt.sign(
        { username: user.username, role: user.role },
        process.env.JWT_SECRET || 'default-jwt-secret',
        { expiresIn: '24h' }
    );
}

// Verify JWT token
function verifyToken(token) {
    try {
        return jwt.verify(token, process.env.JWT_SECRET || 'default-jwt-secret');
    } catch (error) {
        return null;
    }
}

// Middleware to check authentication
function requireAuth(req, res, next) {
    const token = req.cookies.authToken || req.headers.authorization?.split(' ')[1];
    
    if (!token) {
        // Check if this is an API request or a page request
        if (req.path.startsWith('/api/') || req.headers['content-type'] === 'application/json') {
            return res.status(401).json({ error: 'Authentication required' });
        }
        // Redirect to login page for HTML requests
        return res.redirect('/login');
    }
    
    const decoded = verifyToken(token);
    if (!decoded) {
        // Check if this is an API request or a page request
        if (req.path.startsWith('/api/') || req.headers['content-type'] === 'application/json') {
            return res.status(401).json({ error: 'Invalid or expired token' });
        }
        // Redirect to login page for HTML requests
        return res.redirect('/login');
    }
    
    req.user = decoded;
    next();
}

// Socket.io authentication middleware
function socketAuth(socket, next) {
    const token = socket.handshake.auth.token;
    
    if (!token) {
        return next(new Error('Authentication required'));
    }
    
    const decoded = verifyToken(token);
    if (!decoded) {
        return next(new Error('Invalid or expired token'));
    }
    
    socket.user = decoded;
    next();
}

module.exports = {
    initializeUsers,
    authenticateUser,
    generateToken,
    verifyToken,
    requireAuth,
    socketAuth
};