require('dotenv').config();
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { spawn, execSync } = require('child_process');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs').promises;
const { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } = require('fs');
const util = require('util');
const cookieParser = require('cookie-parser');
const { initializeUsers, authenticateUser, generateToken, requireAuth, socketAuth } = require('./auth');
const ngrok = require('ngrok');

const app = express();
app.set('trust proxy', 1); // Trust first proxy (ngrok)

// CORS middleware for ngrok and external access
app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin) {
        res.header('Access-Control-Allow-Origin', origin);
        res.header('Access-Control-Allow-Credentials', 'true');
        res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    }
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

app.use(express.json());
app.use(cookieParser());
const httpServer = createServer(app);
const io = new Server(httpServer, {
    cors: {
        origin: "*"
    }
});

// Apply socket authentication
io.use(socketAuth);

// In-memory storage for conversations and Claude sessions
const conversations = new Map();
const claudeSessions = new Map(); // Map conversation ID to Claude session ID
const activeProcesses = new Map(); // Map socket ID to active Claude process

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

// Authentication routes
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    
    const user = await authenticateUser(username, password);
    if (!user) {
        return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const token = generateToken(user);
    
    // Only use secure cookies if actually using HTTPS
    const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https' || req.protocol === 'https';
    
    res.cookie('authToken', token, {
        httpOnly: true,
        secure: isSecure,
        sameSite: 'lax',
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    });
    
    res.json({ success: true, user: { username: user.username, role: user.role }, token });
});

app.post('/api/logout', (req, res) => {
    res.clearCookie('authToken');
    res.json({ success: true });
});

app.get('/api/auth/check', requireAuth, (req, res) => {
    res.json({ authenticated: true, user: req.user });
});

// API endpoint to get conversation
app.get('/api/conversation/:id', requireAuth, (req, res) => {
    const conversation = conversations.get(req.params.id);
    if (conversation) {
        res.json(conversation);
    } else {
        res.status(404).json({ error: 'Conversation not found' });
    }
});

// API endpoint to update conversation working directory
app.post('/api/conversation/:id/working-directory', requireAuth, async (req, res) => {
    const conversation = conversations.get(req.params.id);
    if (conversation) {
        const { workingDirectory } = req.body;
        
        // Validate the directory exists
        if (!existsSync(workingDirectory)) {
            return res.status(400).json({ error: 'Directory does not exist' });
        }
        
        conversation.workingDirectory = workingDirectory;
        await saveConversation(req.params.id);
        res.json({ success: true, workingDirectory });
    } else {
        res.status(404).json({ error: 'Conversation not found' });
    }
});

// API endpoints for commands
app.get('/api/commands', requireAuth, async (req, res) => {
    try {
        const commandsData = await fs.readFile(path.join(__dirname, 'commands.json'), 'utf-8');
        res.json(JSON.parse(commandsData));
    } catch (error) {
        res.status(500).json({ error: 'Failed to load commands' });
    }
});

app.post('/api/commands', requireAuth, async (req, res) => {
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

// API endpoints for system prompts
app.get('/api/system-prompts', requireAuth, async (req, res) => {
    try {
        const promptsData = await fs.readFile(path.join(__dirname, 'systemPrompts.json'), 'utf-8');
        res.json(JSON.parse(promptsData));
    } catch (error) {
        res.status(500).json({ error: 'Failed to load system prompts' });
    }
});

app.post('/api/system-prompts', requireAuth, async (req, res) => {
    try {
        const { activePrompt, savedPrompts } = req.body;
        const promptsPath = path.join(__dirname, 'systemPrompts.json');
        await fs.writeFile(promptsPath, JSON.stringify({ activePrompt, savedPrompts }, null, 2));
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to save system prompts' });
    }
});

// API endpoint to list repositories
app.get('/api/repositories', requireAuth, async (req, res) => {
    try {
        const repoPath = path.join(__dirname, 'repositories');
        
        // Create repositories directory if it doesn't exist
        if (!existsSync(repoPath)) {
            mkdirSync(repoPath, { recursive: true });
        }
        
        const repositories = await fs.readdir(repoPath);
        const repoList = [];
        
        for (const repo of repositories) {
            const fullPath = path.join(repoPath, repo);
            const stat = await fs.stat(fullPath);
            if (stat.isDirectory()) {
                // Get branches for this repository
                let branches = [];
                let currentBranch = null;
                
                try {
                    // Check if it's a git repository
                    const gitPath = path.join(fullPath, '.git');
                    if (existsSync(gitPath)) {
                        // Fetch latest remote branches
                        try {
                            execSync('git fetch --prune', { cwd: fullPath, encoding: 'utf8' });
                        } catch (fetchError) {
                            console.warn(`Failed to fetch remote branches for ${repo}:`, fetchError.message);
                        }
                        
                        // Get all branches
                        const branchOutput = execSync('git branch -a', { cwd: fullPath, encoding: 'utf8' });
                        const branchSet = new Set();
                        
                        branchOutput.split('\n')
                            .filter(branch => branch.trim())
                            .forEach(branch => {
                                const isActive = branch.startsWith('*');
                                let branchName = branch.replace(/^\*?\s+/, '');
                                
                                // Handle local branches
                                if (!branchName.startsWith('remotes/')) {
                                    if (isActive) {
                                        currentBranch = branchName;
                                    }
                                    branchSet.add(branchName);
                                } 
                                // Handle remote branches
                                else if (branchName.startsWith('remotes/origin/') && !branchName.includes('HEAD')) {
                                    const remoteBranch = branchName.replace('remotes/origin/', '');
                                    branchSet.add(remoteBranch);
                                }
                            });
                        
                        branches = Array.from(branchSet).sort();
                    }
                } catch (error) {
                    console.warn(`Failed to get branches for ${repo}:`, error.message);
                }
                
                repoList.push({
                    name: repo,
                    path: fullPath,
                    lastModified: stat.mtime,
                    branches: branches,
                    currentBranch: currentBranch
                });
            }
        }
        
        // Sort by last modified date (newest first)
        repoList.sort((a, b) => b.lastModified - a.lastModified);
        
        res.json({ repositories: repoList });
    } catch (error) {
        console.error('Failed to list repositories:', error);
        res.status(500).json({ error: 'Failed to list repositories' });
    }
});

// API endpoint to switch branch in repository
app.post('/api/repositories/:repo/switch-branch', requireAuth, async (req, res) => {
    try {
        const { repo } = req.params;
        const { branch } = req.body;
        
        if (!repo || !branch) {
            return res.status(400).json({ error: 'Repository and branch are required' });
        }
        
        const repoPath = path.join(__dirname, 'repositories', repo);
        
        if (!existsSync(repoPath)) {
            return res.status(404).json({ error: 'Repository not found' });
        }
        
        // Switch to the specified branch
        try {
            // Always reset hard before switching branches to ensure clean state
            execSync('git reset --hard', { cwd: repoPath, encoding: 'utf8' });
            
            // Check if branch exists locally
            const localBranches = execSync('git branch', { cwd: repoPath, encoding: 'utf8' });
            const hasLocalBranch = localBranches.split('\n').some(b => b.trim().replace('* ', '') === branch);
            
            if (hasLocalBranch) {
                // Branch exists locally, just checkout
                execSync(`git checkout ${branch}`, { cwd: repoPath, encoding: 'utf8' });
            } else {
                // Branch doesn't exist locally, try to create it from remote
                execSync('git fetch origin', { cwd: repoPath, encoding: 'utf8' });
                
                // Check if remote branch exists
                const remoteBranches = execSync('git branch -r', { cwd: repoPath, encoding: 'utf8' });
                const hasRemoteBranch = remoteBranches.split('\n').some(b => 
                    b.trim() === `origin/${branch}` || b.trim().endsWith(`/${branch}`)
                );
                
                if (hasRemoteBranch) {
                    // Create local branch tracking the remote
                    execSync(`git checkout -b ${branch} origin/${branch}`, { cwd: repoPath, encoding: 'utf8' });
                } else {
                    throw new Error(`Branch ${branch} not found in local or remote`);
                }
            }
            
            res.json({ success: true, message: `Switched to branch ${branch}` });
        } catch (error) {
            console.error('Failed to switch branch:', error);
            res.status(500).json({ error: `Failed to switch to branch ${branch}: ${error.message}` });
        }
    } catch (error) {
        console.error('Failed to switch branch:', error);
        res.status(500).json({ error: 'Failed to switch branch' });
    }
});

// API endpoint to list projects (cloned repositories)
app.get('/api/projects', requireAuth, async (req, res) => {
    try {
        const projectsPath = path.join(__dirname, 'projects');
        
        // Create projects directory if it doesn't exist
        if (!existsSync(projectsPath)) {
            mkdirSync(projectsPath, { recursive: true });
        }
        
        const projects = await fs.readdir(projectsPath);
        const projectList = [];
        
        for (const project of projects) {
            const fullPath = path.join(projectsPath, project);
            const stat = await fs.stat(fullPath);
            if (stat.isDirectory()) {
                projectList.push({
                    name: project,
                    path: fullPath,
                    lastModified: stat.mtime
                });
            }
        }
        
        // Sort by last modified date (newest first)
        projectList.sort((a, b) => b.lastModified - a.lastModified);
        
        res.json({ projects: projectList });
    } catch (error) {
        console.error('Failed to list projects:', error);
        res.status(500).json({ error: 'Failed to list projects' });
    }
});

// Serve login page
app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'login.html'));
});

// Serve static files (CSS, JS) without authentication
app.use('/styles.css', express.static(path.join(__dirname, 'styles.css')));
app.use('/app.js', express.static(path.join(__dirname, 'app.js')));

// Protected routes - require authentication
app.get('/', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});
app.get('/c/:id', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});
app.use(express.static(__dirname));

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

    // Handle setting working directory
    socket.on('setWorkingDirectory', async ({ conversationId, workingDirectory }, callback) => {
        const conversation = conversations.get(conversationId);
        if (conversation) {
            try {
                // Create directory if it doesn't exist
                if (!existsSync(workingDirectory)) {
                    mkdirSync(workingDirectory, { recursive: true });
                    console.log(`Created directory: ${workingDirectory}`);
                }
                
                conversation.workingDirectory = workingDirectory;
                await saveConversation(conversationId);
                callback({ success: true, workingDirectory, created: true });
            } catch (error) {
                console.error(`Failed to create directory: ${error.message}`);
                callback({ error: `Failed to create directory: ${error.message}` });
            }
        } else {
            callback({ error: 'Conversation not found' });
        }
    });

    // Handle cloning repository
    socket.on('cloneRepository', async ({ conversationId, repository, projectName, branch }) => {
        try {
            const sourcePath = path.join(__dirname, 'repositories', repository);
            const hotPath = path.join(__dirname, 'hot', repository);
            const destPath = path.join(__dirname, 'projects', projectName);
            
            // Check if source repository exists
            if (!existsSync(sourcePath)) {
                socket.emit('error', { message: `Repository "${repository}" not found` });
                return;
            }
            
            // Check if destination already exists
            if (existsSync(destPath)) {
                socket.emit('error', { message: `Project "${projectName}" already exists` });
                return;
            }
            
            // Create projects directory if it doesn't exist
            const projectsDir = path.join(__dirname, 'projects');
            if (!existsSync(projectsDir)) {
                mkdirSync(projectsDir, { recursive: true });
            }
            
            // Create hot directory if it doesn't exist
            const hotDir = path.join(__dirname, 'hot');
            if (!existsSync(hotDir)) {
                mkdirSync(hotDir, { recursive: true });
            }
            
            const { exec } = require('child_process');
            
            // Check if we have a hot copy available
            if (existsSync(hotPath)) {
                console.log(`Using hot copy of repository "${repository}"...`);
                
                // Move hot copy to destination
                exec(`mv "${hotPath}" "${destPath}"`, (error, stdout, stderr) => {
                    if (error) {
                        console.error(`Error moving hot repository: ${error}`);
                        // Fall back to regular copy
                        copyFromSource();
                        return;
                    }
                    
                    console.log(`Moved hot repository "${repository}" to "${destPath}"`);
                    
                    // Update the moved repository with git pull
                    exec(`cd "${destPath}" && git pull`, (pullError) => {
                        if (pullError) {
                            console.warn(`Warning: Failed to git pull in ${destPath}: ${pullError.message}`);
                        }
                        
                        handleBranchCheckout();
                    });
                    
                    // Immediately start preparing a new hot copy in the background
                    prepareHotCopy(repository);
                });
            } else {
                // No hot copy available, use regular copy
                copyFromSource();
            }
            
            function copyFromSource() {
                // First, update the source repository with git pull
                console.log(`Updating repository "${repository}" with git pull...`);
                exec(`cd "${sourcePath}" && git pull`, (pullError, pullStdout, pullStderr) => {
                    if (pullError) {
                        console.warn(`Warning: Failed to git pull in ${sourcePath}: ${pullError.message}`);
                        // Continue with cloning even if pull fails (repository might not have a remote)
                    } else {
                        console.log(`Successfully updated repository "${repository}"`);
                    }
                    
                    // Copy repository to projects folder
                    exec(`cp -r "${sourcePath}" "${destPath}"`, (error, stdout, stderr) => {
                    if (error) {
                        console.error(`Error copying repository: ${error}`);
                        console.error(`stderr: ${stderr}`);
                        console.error(`Source: ${sourcePath}`);
                        console.error(`Destination: ${destPath}`);
                        socket.emit('error', { message: `Failed to clone repository: ${error.message}` });
                        return;
                    }
                
                console.log(`Cloned repository "${repository}" to "${destPath}"`);
                
                handleBranchCheckout();
                
                // Start preparing a hot copy after regular clone
                prepareHotCopy(repository);
            });
            });
            }
            
            function handleBranchCheckout() {
                // If a branch was specified, checkout that branch
                if (branch) {
                    exec(`cd "${destPath}" && git checkout ${branch}`, (branchError, branchStdout, branchStderr) => {
                        if (branchError) {
                            console.warn(`Warning: Failed to checkout branch ${branch}: ${branchError.message}`);
                            // Don't fail the clone operation, just warn
                        } else {
                            console.log(`Checked out branch "${branch}" in ${destPath}`);
                        }
                        
                        socket.emit('repositoryCloned', {
                            repository,
                            projectName,
                            path: destPath,
                            branch: branch
                        });
                    });
                } else {
                    socket.emit('repositoryCloned', {
                        repository,
                        projectName,
                        path: destPath
                    });
                }
            }
            
            function prepareHotCopy(repoName) {
                const sourceRepo = path.join(__dirname, 'repositories', repoName);
                const hotRepo = path.join(__dirname, 'hot', repoName);
                
                // Don't prepare hot copy if it already exists
                if (existsSync(hotRepo)) {
                    return;
                }
                
                console.log(`Preparing hot copy of repository "${repoName}" in background...`);
                
                // Copy repository to hot folder in background
                exec(`cp -r "${sourceRepo}" "${hotRepo}"`, (error) => {
                    if (error) {
                        console.error(`Failed to prepare hot copy: ${error.message}`);
                    } else {
                        console.log(`Hot copy of repository "${repoName}" is ready`);
                    }
                });
            }
        } catch (error) {
            console.error('Error in cloneRepository:', error);
            socket.emit('error', { message: `Failed to clone repository: ${error.message}` });
        }
    });

    // Handle creating a new conversation
    socket.on('createConversation', async (callback) => {
        const conversationId = crypto.randomBytes(8).toString('hex');
        currentConversationId = conversationId;
        socket.join(conversationId);
        
        conversations.set(conversationId, {
            id: conversationId,
            messages: [],
            workingDirectory: process.cwd(),
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
        let workingDirectory = conversation.workingDirectory || process.cwd();
        let actualPrompt = prompt;
        
        // Pattern to match: ./path/to/folder/claude <actual prompt>
        const pathPattern = /^(\.\/[^\s]+)\/claude\s+(.+)$/;
        const match = prompt.match(pathPattern);
        
        if (match) {
            const folderPath = match[1];
            actualPrompt = match[2];
            
            // Extract the folder name from the path (e.g., "./myproject" -> "myproject")
            const folderName = folderPath.replace(/^\.\//, '');
            
            // Resolve the full path within the projects directory
            const fullPath = path.resolve(process.cwd(), 'projects', folderName);
            
            try {
                // Check if this matches a repository name
                const repositoriesPath = path.join(__dirname, 'repositories');
                const hotPath = path.join(__dirname, 'hot', folderName);
                const sourcePath = path.join(repositoriesPath, folderName);
                
                if (existsSync(sourcePath) && !existsSync(fullPath)) {
                    // This is a repository name and project doesn't exist yet
                    console.log(`Detected repository name "${folderName}", using hot folder system`);
                    
                    const { exec } = require('child_process');
                    
                    // Check if we have a hot copy available
                    if (existsSync(hotPath)) {
                        console.log(`Using hot copy of repository "${folderName}"...`);
                        
                        // Move hot copy to destination synchronously
                        try {
                            execSync(`mv "${hotPath}" "${fullPath}"`);
                            console.log(`Moved hot repository "${folderName}" to "${fullPath}"`);
                            
                            // Update the moved repository with git pull
                            try {
                                execSync(`cd "${fullPath}" && git pull`);
                            } catch (pullError) {
                                console.warn(`Warning: Failed to git pull in ${fullPath}: ${pullError.message}`);
                            }
                            
                            socket.emit('output', JSON.stringify({
                                type: 'system',
                                message: `Using hot copy of repository: ${fullPath}`
                            }) + '\n');
                            
                            // Immediately start preparing a new hot copy in the background
                            prepareHotCopy(folderName);
                        } catch (error) {
                            console.error(`Error moving hot repository: ${error}`);
                            // Fall back to regular copy
                            copyRepositorySync(sourcePath, fullPath);
                        }
                    } else {
                        // No hot copy available, use regular copy
                        copyRepositorySync(sourcePath, fullPath);
                        // Start preparing a hot copy after regular clone
                        prepareHotCopy(folderName);
                    }
                } else if (!existsSync(fullPath)) {
                    // Not a repository, just create directory
                    mkdirSync(fullPath, { recursive: true });
                    console.log(`Created directory in projects folder: ${fullPath}`);
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
        
        // Helper function to copy repository synchronously
        function copyRepositorySync(source, dest) {
            try {
                // First, update the source repository with git pull
                console.log(`Updating repository with git pull...`);
                try {
                    execSync(`cd "${source}" && git pull`);
                    console.log(`Successfully updated repository`);
                } catch (pullError) {
                    console.warn(`Warning: Failed to git pull: ${pullError.message}`);
                }
                
                // Copy repository to projects folder
                execSync(`cp -r "${source}" "${dest}"`);
                console.log(`Cloned repository to "${dest}"`);
                
                socket.emit('output', JSON.stringify({
                    type: 'system',
                    message: `Cloned repository to: ${dest}`
                }) + '\n');
            } catch (error) {
                throw new Error(`Failed to copy repository: ${error.message}`);
            }
        }
        
        // Helper function to prepare hot copy
        function prepareHotCopy(repoName) {
            const sourceRepo = path.join(__dirname, 'repositories', repoName);
            const hotRepo = path.join(__dirname, 'hot', repoName);
            
            // Don't prepare hot copy if it already exists
            if (existsSync(hotRepo)) {
                return;
            }
            
            // Create hot directory if it doesn't exist
            const hotDir = path.join(__dirname, 'hot');
            if (!existsSync(hotDir)) {
                mkdirSync(hotDir, { recursive: true });
            }
            
            console.log(`Preparing hot copy of repository "${repoName}" in background...`);
            
            // Copy repository to hot folder in background
            const { exec } = require('child_process');
            exec(`cp -r "${sourceRepo}" "${hotRepo}"`, (error) => {
                if (error) {
                    console.error(`Failed to prepare hot copy: ${error.message}`);
                } else {
                    console.log(`Hot copy of repository "${repoName}" is ready`);
                }
            });
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
        
        // Add system prompt if one is active
        try {
            const systemPromptsPath = path.join(__dirname, 'systemPrompts.json');
            if (existsSync(systemPromptsPath)) {
                const systemPromptsData = JSON.parse(readFileSync(systemPromptsPath, 'utf-8'));
                if (systemPromptsData.activePrompt) {
                    args.push('--append-system-prompt', systemPromptsData.activePrompt);
                }
            }
        } catch (error) {
            console.error('Error loading system prompt:', error);
        }
        
        // Use claude with stdin input which works more reliably
        const claudeProcess = spawn('claude', args, {
            shell: false,
            cwd: workingDirectory,  // Set the working directory
            env: { ...process.env, PATH: process.env.PATH + ':/Users/arturhanusek/Library/Application Support/Herd/config/nvm/versions/node/v20.19.3/bin' },
            stdio: ['pipe', 'pipe', 'pipe']
        });
        
        // Store the active process
        activeProcesses.set(socket.id, claudeProcess);
        
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
            // Remove the process from active processes
            activeProcesses.delete(socket.id);
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

    socket.on('stopPrompt', () => {
        console.log('Stop request received');
        const claudeProcess = activeProcesses.get(socket.id);
        if (claudeProcess) {
            try {
                claudeProcess.kill('SIGTERM');
                // If process doesn't terminate gracefully, force kill after 1 second
                setTimeout(() => {
                    if (activeProcesses.has(socket.id)) {
                        claudeProcess.kill('SIGKILL');
                    }
                }, 1000);
                socket.emit('output', JSON.stringify({
                    type: 'system',
                    message: 'Process stopped by user'
                }) + '\n');
            } catch (error) {
                console.error('Error stopping process:', error);
                socket.emit('error', 'Failed to stop process');
            }
        }
    });

    socket.on('disconnect', () => {
        console.log('Client disconnected');
        // Clean up any active process on disconnect
        const claudeProcess = activeProcesses.get(socket.id);
        if (claudeProcess) {
            try {
                claudeProcess.kill('SIGTERM');
                activeProcesses.delete(socket.id);
            } catch (error) {
                console.error('Error cleaning up process on disconnect:', error);
            }
        }
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

// Start ngrok tunnel
async function startNgrok(port) {
    try {
        // Check if ngrok should be enabled (from env or default to true)
        const enableNgrok = process.env.ENABLE_NGROK !== 'false';
        
        if (!enableNgrok) {
            console.log('Ngrok is disabled');
            return null;
        }
        
        // Configure ngrok options
        const ngrokOptions = {
            addr: port,
            proto: 'http',
            region: process.env.NGROK_REGION || 'us',
        };
        
        // Add authtoken if provided
        if (process.env.NGROK_AUTHTOKEN) {
            ngrokOptions.authtoken = process.env.NGROK_AUTHTOKEN;
        }
        
        // Add subdomain if provided (requires paid ngrok account)
        if (process.env.NGROK_SUBDOMAIN) {
            ngrokOptions.subdomain = process.env.NGROK_SUBDOMAIN;
        }
        
        // Start ngrok
        const url = await ngrok.connect(ngrokOptions);
        console.log(`\n🌍 Ngrok tunnel established: ${url}`);
        console.log(`   You can access your ClaudeChat instance from anywhere using this URL`);
        
        return url;
    } catch (error) {
        console.error('Failed to start ngrok:', error.message);
        console.log('Continuing without ngrok...');
        return null;
    }
}

// Start server with automatic port cleanup
async function startServer() {
    try {
        // Initialize authentication users
        await initializeUsers();
        
        // Kill any existing process on the port
        await killProcessOnPort(PORT);
        
        // Start the server
        httpServer.listen(PORT, async () => {
            console.log(`Server running on http://localhost:${PORT}`);
            
            // Start ngrok after server is running
            const ngrokUrl = await startNgrok(PORT);
            
            // Store ngrok URL for potential use in the application
            if (ngrokUrl) {
                app.locals.ngrokUrl = ngrokUrl;
            }
        });
        
        // Handle server errors
        httpServer.on('error', async (error) => {
            if (error.code === 'EADDRINUSE') {
                console.log(`Port ${PORT} is in use, attempting to kill existing process...`);
                await killProcessOnPort(PORT);
                // Retry starting the server
                setTimeout(() => {
                    httpServer.listen(PORT, async () => {
                        console.log(`Server running on http://localhost:${PORT} (after retry)`);
                        
                        // Start ngrok after server is running
                        const ngrokUrl = await startNgrok(PORT);
                        
                        // Store ngrok URL for potential use in the application
                        if (ngrokUrl) {
                            app.locals.ngrokUrl = ngrokUrl;
                        }
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

// Handle graceful shutdown
process.on('SIGINT', async () => {
    console.log('\nShutting down gracefully...');
    
    // Disconnect ngrok
    try {
        await ngrok.disconnect();
        await ngrok.kill();
        console.log('Ngrok disconnected');
    } catch (error) {
        console.error('Error disconnecting ngrok:', error.message);
    }
    
    // Close server
    httpServer.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
    
    // Force exit after 5 seconds
    setTimeout(() => {
        console.error('Forced shutdown');
        process.exit(1);
    }, 5000);
});

// Load persisted data and start server
loadPersistedData();
startServer();