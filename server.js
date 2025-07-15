const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { spawn } = require('child_process');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs').promises;

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
    socket.on('createConversation', (callback) => {
        const conversationId = crypto.randomBytes(8).toString('hex');
        currentConversationId = conversationId;
        socket.join(conversationId);
        
        conversations.set(conversationId, {
            id: conversationId,
            messages: [],
            createdAt: new Date().toISOString()
        });
        
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

        // Write the prompt to stdin
        claudeProcess.stdin.write(prompt);
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
httpServer.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});