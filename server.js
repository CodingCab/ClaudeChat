const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { spawn } = require('child_process');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs').promises;
const { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } = require('fs');
const util = require('util');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
    cors: {
        origin: "*"
    }
});

// In-memory storage for conversations and Claude sessions
const conversations = new Map();
const claudeSessions = new Map(); // Map conversation ID to Claude session ID

// Persistence paths
const DATA_DIR = path.join(__dirname, 'data');
const CONVERSATIONS_DIR = path.join(DATA_DIR, 'conversations');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

// Ensure data directories exist
if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
}
if (!existsSync(CONVERSATIONS_DIR)) {
    mkdirSync(CONVERSATIONS_DIR, { recursive: true });
}

// Load persisted data on startup
function loadPersistedData() {
    // Load conversations
    try {
        const files = readdirSync(CONVERSATIONS_DIR);
        files.forEach(file => {
            if (file.endsWith('.json')) {
                const conversationData = JSON.parse(readFileSync(path.join(CONVERSATIONS_DIR, file), 'utf-8'));
                conversations.set(conversationData.id, conversationData);
            }
        });
        console.log(`Loaded ${conversations.size} conversations`);
    } catch (error) {
        console.log('No existing conversations found or error loading:', error.message);
    }
    
    // Load Claude sessions
    try {
        if (existsSync(SESSIONS_FILE)) {
            const sessionsData = JSON.parse(readFileSync(SESSIONS_FILE, 'utf-8'));
            Object.entries(sessionsData).forEach(([conversationId, sessionId]) => {
                claudeSessions.set(conversationId, sessionId);
            });
            console.log(`Loaded ${claudeSessions.size} Claude sessions`);
        }
    } catch (error) {
        console.log('No existing sessions found or error loading:', error.message);
    }
}

// Save conversation to disk
async function saveConversation(conversationId) {
    const conversation = conversations.get(conversationId);
    if (conversation) {
        const filePath = path.join(CONVERSATIONS_DIR, `${conversationId}.json`);
        await fs.writeFile(filePath, JSON.stringify(conversation, null, 2));
    }
}

// Save all Claude sessions to disk
function saveSessions() {
    const sessionsObj = {};
    claudeSessions.forEach((sessionId, conversationId) => {
        sessionsObj[conversationId] = sessionId;
    });
    writeFileSync(SESSIONS_FILE, JSON.stringify(sessionsObj, null, 2));
}

// Load data on startup
loadPersistedData();

// Middleware
app.use(express.json());

// API endpoint to get conversation
app.get('/api/conversation/:id', (req, res) => {
    const conversation = conversations.get(req.params.id);
    if (conversation) {
        res.json(conversation);
    } else {
        res.status(404).json({ error: 'Conversation not found' });
    }
});

// API endpoints for commands
app.get('/api/commands', async (req, res) => {
    try {
        const commandsData = await fs.readFile(path.join(__dirname, 'commands.json'), 'utf-8');
        res.json(JSON.parse(commandsData));
    } catch (error) {
        res.status(500).json({ error: 'Failed to load commands' });
    }
});

app.post('/api/commands', async (req, res) => {
    try {
        const { customCommands } = req.body;
        const commandsPath = path.join(__dirname, 'commands.json');
        const currentData = JSON.parse(await fs.readFile(commandsPath, 'utf-8'));
        currentData.customCommands = customCommands;
        await fs.writeFile(commandsPath, JSON.stringify(currentData, null, 2));
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to save commands' });
    }
});

// Serve static files for root and conversation paths
app.use(express.static(__dirname));
app.get('/c/:id', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// WebSocket connection handling
io.on('connection', (socket) => {
    console.log('Client connected');
    
    let currentConversationId = null;

    // Handle joining a conversation
    socket.on('joinConversation', (conversationId) => {
        currentConversationId = conversationId;
        socket.join(conversationId);
        console.log(`Client joined conversation: ${conversationId}`);
    });

    // Handle creating a new conversation
    socket.on('createConversation', async (callback) => {
        const conversationId = crypto.randomBytes(8).toString('hex');
        currentConversationId = conversationId;
        socket.join(conversationId);
        
        conversations.set(conversationId, {
            id: conversationId,
            messages: [],
            createdAt: new Date().toISOString()
        });
        
        // Save new conversation to disk
        await saveConversation(conversationId);
        
        console.log(`Created new conversation: ${conversationId}`);
        callback(conversationId);
    });

    socket.on('sendPrompt', (prompt) => {
        console.log('Received prompt:', prompt);
        
        if (!currentConversationId) {
            socket.emit('error', 'No conversation ID set');
            return;
        }
        
        const conversation = conversations.get(currentConversationId);
        if (!conversation) {
            socket.emit('error', 'Conversation not found');
            return;
        }
        
        // Check if prompt starts with a path pattern (e.g., "./folder/claude ...")
        let workingDirectory = process.cwd();
        let actualPrompt = prompt;
        
        // Pattern to match: ./path/to/folder/claude <actual prompt>
        const pathPattern = /^(\.\/[^\s]+)\/claude\s+(.+)$/;
        const match = prompt.match(pathPattern);
        
        if (match) {
            const folderPath = match[1];
            actualPrompt = match[2];
            
            // Resolve the full path
            const fullPath = path.resolve(process.cwd(), folderPath);
            
            try {
                // Create directory if it doesn't exist
                if (!existsSync(fullPath)) {
                    mkdirSync(fullPath, { recursive: true });
                    console.log(`Created directory: ${fullPath}`);
                    socket.emit('output', JSON.stringify({
                        type: 'system',
                        message: `Created directory: ${fullPath}`
                    }) + '\n');
                }
                
                // Set working directory for Claude
                workingDirectory = fullPath;
                console.log(`Running Claude from directory: ${workingDirectory}`);
                
            } catch (error) {
                console.error(`Failed to create directory: ${error.message}`);
                socket.emit('error', `Failed to create directory: ${error.message}`);
                return;
            }
        }
        
        // Build claude command args
        const args = [
            '--print', 
            '--output-format', 'stream-json', 
            '--verbose',
            '--allowedTools', 'LS,Read,Write,Edit,Bash,Grep,Glob,WebSearch,WebFetch'
        ];
        
        // Add resume option if we have a session ID for this conversation
        const claudeSessionId = claudeSessions.get(currentConversationId);
        if (claudeSessionId) {
            args.push('--resume', claudeSessionId);
        }
        
        // Use claude with stdin input which works more reliably
        const claudeProcess = spawn('claude', args, {
            shell: false,
            cwd: workingDirectory,  // Set the working directory
            env: { ...process.env, PATH: process.env.PATH + ':/Users/arturhanusek/Library/Application Support/Herd/config/nvm/versions/node/v20.19.3/bin' },
            stdio: ['pipe', 'pipe', 'pipe']
        });
        
        let outputBuffer = '';
        let errorBuffer = '';
        const messageBuffer = [];
        
        // Add user message to conversation
        conversation.messages.push({
            type: 'user',
            content: prompt,
            timestamp: new Date().toISOString()
        });
        // Save conversation after adding user message
        saveConversation(currentConversationId);

        // Write the actual prompt (without path prefix) to stdin
        claudeProcess.stdin.write(actualPrompt);
        claudeProcess.stdin.end();

        // Send stdout data to client in real-time
        claudeProcess.stdout.on('data', (data) => {
            const output = data.toString();
            outputBuffer += output;
            console.log('Claude stdout:', output);
            socket.emit('output', output);
            
            // Store messages for conversation history
            try {
                const lines = output.trim().split('\n');
                lines.forEach(line => {
                    if (line.trim()) {
                        const json = JSON.parse(line);
                        messageBuffer.push(json);
                        
                        // Capture Claude session ID
                        if (json.session_id && !claudeSessions.has(currentConversationId)) {
                            claudeSessions.set(currentConversationId, json.session_id);
                            console.log(`Stored Claude session ${json.session_id} for conversation ${currentConversationId}`);
                            // Save sessions to disk
                            saveSessions();
                        }
                    }
                });
            } catch (e) {
                // Ignore parsing errors
            }
        });

        // Send stderr data to client
        claudeProcess.stderr.on('data', (data) => {
            const error = data.toString();
            errorBuffer += error;
            console.error('Claude stderr:', error);
            socket.emit('error', error);
        });

        // Handle process completion
        claudeProcess.on('close', (code) => {
            console.log(`Claude process exited with code ${code}`);
            if (code !== 0 && errorBuffer) {
                console.error('Full error output:', errorBuffer);
            }
            if (outputBuffer) {
                console.log('Full output:', outputBuffer);
            }
            
            // Store Claude's response in conversation
            if (messageBuffer.length > 0) {
                conversation.messages.push({
                    type: 'assistant',
                    content: messageBuffer,
                    timestamp: new Date().toISOString()
                });
                // Save conversation to disk
                saveConversation(currentConversationId);
            }
            
            socket.emit('complete', code);
        });

        // Handle process errors
        claudeProcess.on('error', (err) => {
            console.error('Failed to start claude:', err);
            socket.emit('error', `Failed to start claude: ${err.message}`);
        });
    });

    socket.on('disconnect', () => {
        console.log('Client disconnected');
    });
});

const PORT = process.env.PORT || 3000;

// Function to kill any process using the port
async function killProcessOnPort(port) {
    const { exec } = require('child_process');
    const util = require('util');
    const execPromise = util.promisify(exec);
    
    try {
        // Find process using the port
        const { stdout } = await execPromise(`lsof -ti :${port}`);
        if (stdout.trim()) {
            const pids = stdout.trim().split('\n');
            for (const pid of pids) {
                try {
                    await execPromise(`kill -9 ${pid}`);
                    console.log(`Killed process ${pid} on port ${port}`);
                } catch (killError) {
                    console.error(`Failed to kill process ${pid}:`, killError.message);
                }
            }
            // Wait a bit for the port to be released
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    } catch (error) {
        // No process found on port, which is fine
        if (!error.message.includes('lsof: status error')) {
            console.log(`No process found on port ${port}`);
        }
    }
}

// Start server with automatic port cleanup
async function startServer() {
    try {
        // Kill any existing process on the port
        await killProcessOnPort(PORT);
        
        // Start the server
        httpServer.listen(PORT, () => {
            console.log(`Server running on http://localhost:${PORT}`);
        });
        
        // Handle server errors
        httpServer.on('error', async (error) => {
            if (error.code === 'EADDRINUSE') {
                console.log(`Port ${PORT} is in use, attempting to kill existing process...`);
                await killProcessOnPort(PORT);
                // Retry starting the server
                setTimeout(() => {
                    httpServer.listen(PORT, () => {
                        console.log(`Server running on http://localhost:${PORT} (after retry)`);
                    });
                }, 1000);
            } else {
                console.error('Server error:', error);
                process.exit(1);
            }
        });
    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
}

// Load persisted data and start server
loadPersistedData();
startServer();