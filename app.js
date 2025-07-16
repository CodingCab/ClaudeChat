// Get auth token from localStorage
const authToken = localStorage.getItem('authToken');
if (!authToken) {
    window.location.href = '/login?redirect=' + encodeURIComponent(window.location.pathname);
}

const socket = io({
    auth: {
        token: authToken
    }
});

// Handle authentication errors
socket.on('connect_error', (error) => {
    if (error.message === 'Authentication required' || error.message === 'Invalid or expired token') {
        localStorage.removeItem('authToken');
        window.location.href = '/login?redirect=' + encodeURIComponent(window.location.pathname);
    }
});

// Handle socket reconnection - rejoin conversation if we have one
socket.on('connect', () => {
    console.log('Socket connected');
    if (conversationId) {
        console.log('Rejoining conversation:', conversationId);
        socket.emit('joinConversation', conversationId);
    }
});

const chatOutput = document.getElementById('chatOutput');
const chatInput = document.getElementById('chatInput');
const sendButton = document.getElementById('sendButton');
const workingDirectoryInput = document.getElementById('workingDirectory');
const setDirectoryButton = document.getElementById('setDirectoryButton');
const repositoryDropdown = document.getElementById('repositoryDropdown');
const branchDropdown = document.getElementById('branchDropdown');
const branchLabel = document.getElementById('branchLabel');
const projectNameInput = document.getElementById('projectName');
const cloneRepoButton = document.getElementById('cloneRepoButton');

let isProcessing = false;
let currentMessages = [];
let conversationId = null;
let isWaitingResponse = false; // Track if we're waiting for Claude's response
let repositoriesData = {}; // Store repository data including branches

// Helper function to escape HTML
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Initialize conversation
function initializeConversation() {
    // Check if we're loading an existing conversation
    const pathMatch = window.location.pathname.match(/^\/c\/([a-f0-9]+)$/);
    
    if (pathMatch) {
        // Load existing conversation
        conversationId = pathMatch[1];
        loadConversation(conversationId);
    } else {
        // Show welcome message for new conversation
        showWelcomeMessage();
    }
}

// Load existing conversation
async function loadConversation(id) {
    try {
        const response = await fetch(`/api/conversation/${id}`, {
            headers: {
                'Authorization': `Bearer ${authToken}`
            }
        });
        if (response.ok) {
            const conversation = await response.json();
            conversationId = id;
            socket.emit('joinConversation', conversationId);
            
            // Set working directory if available
            if (conversation.workingDirectory) {
                workingDirectoryInput.value = conversation.workingDirectory;
            }
            
            // Clear chat and display conversation history
            chatOutput.innerHTML = '';
            displayConversationHistory(conversation);
        } else {
            // Conversation not found, redirect to home
            window.location.href = '/';
        }
    } catch (error) {
        console.error('Failed to load conversation:', error);
        window.location.href = '/';
    }
}

// Display conversation history
function displayConversationHistory(conversation) {
    conversation.messages.forEach(message => {
        if (message.type === 'user') {
            addMessage(message.content, 'user-message');
        } else if (message.type === 'assistant' && message.content) {
            // Replay assistant messages
            message.content.forEach(item => {
                if (item.type === 'assistant' && item.message && item.message.content) {
                    item.message.content.forEach(content => {
                        if (content.type === 'text') {
                            addMessage(content.text, 'claude-message');
                        } else if (content.type === 'tool_use') {
                            addMessage(content, 'claude-message');
                        }
                    });
                } else if (item.type === 'user' && item.message && item.message.content) {
                    item.message.content.forEach(content => {
                        if (content.type === 'tool_result') {
                            console.log('Loading tool_result from history:', content);
                            addMessage(content, 'claude-message');
                        }
                    });
                }
            });
        }
    });
}

// Load and display commands
async function loadCommands() {
    try {
        const response = await fetch('/api/commands', {
            headers: {
                'Authorization': `Bearer ${authToken}`
            }
        });
        const data = await response.json();
        return data;
    } catch (error) {
        console.error('Failed to load commands:', error);
        return { defaultCommands: [], customCommands: [] };
    }
}

// Show welcome message with commands
async function showWelcomeMessage() {
    const commands = await loadCommands();
    const allCommands = [...commands.defaultCommands, ...commands.customCommands];
    
    const welcomeDiv = document.createElement('div');
    welcomeDiv.className = 'welcome-message';
    welcomeDiv.innerHTML = `
        <div class="commands-header">
            <h3>Quick Commands</h3>
            <button class="add-command-btn" title="Add custom command">+</button>
        </div>
        <div class="commands-grid">
            ${allCommands.map((cmd, index) => `
                <div class="command-card" data-command="${cmd.text}" data-index="${index}">
                    <div class="command-icon">${cmd.icon || '⚡'}</div>
                    <div class="command-content">
                        <div class="command-text">${cmd.text}</div>
                        <div class="command-description">${cmd.description}</div>
                    </div>
                    ${index >= commands.defaultCommands.length ? 
                        `<button class="delete-command" data-index="${index - commands.defaultCommands.length}">×</button>` : ''}
                </div>
            `).join('')}
        </div>
    `;
    chatOutput.appendChild(welcomeDiv);
    
    // Make command cards clickable to execute
    const commandCards = welcomeDiv.querySelectorAll('.command-card');
    commandCards.forEach(card => {
        card.addEventListener('click', (e) => {
            if (!e.target.classList.contains('delete-command')) {
                const command = card.getAttribute('data-command');
                chatInput.value = command;
                sendPrompt();
            }
        });
    });
    
    // Add command button
    const addBtn = welcomeDiv.querySelector('.add-command-btn');
    addBtn.addEventListener('click', showAddCommandDialog);
    
    // Delete command buttons
    const deleteButtons = welcomeDiv.querySelectorAll('.delete-command');
    deleteButtons.forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const index = parseInt(btn.getAttribute('data-index'));
            await deleteCustomCommand(index);
        });
    });
}

// Show add command dialog
function showAddCommandDialog() {
    const dialog = document.createElement('div');
    dialog.className = 'command-dialog-overlay';
    dialog.innerHTML = `
        <div class="command-dialog">
            <h3>Add Custom Command</h3>
            <input type="text" id="newCommandText" placeholder="Command text" />
            <input type="text" id="newCommandDesc" placeholder="Description" />
            <input type="text" id="newCommandIcon" placeholder="Icon (emoji)" maxlength="2" />
            <div class="dialog-buttons">
                <button class="cancel-btn">Cancel</button>
                <button class="save-btn">Save</button>
            </div>
        </div>
    `;
    document.body.appendChild(dialog);
    
    // Focus first input
    dialog.querySelector('#newCommandText').focus();
    
    // Handle cancel
    dialog.querySelector('.cancel-btn').addEventListener('click', () => {
        dialog.remove();
    });
    
    // Handle save
    dialog.querySelector('.save-btn').addEventListener('click', async () => {
        const text = dialog.querySelector('#newCommandText').value.trim();
        const description = dialog.querySelector('#newCommandDesc').value.trim();
        const icon = dialog.querySelector('#newCommandIcon').value.trim() || '⚡';
        
        if (text && description) {
            await saveCustomCommand({ text, description, icon });
            dialog.remove();
        }
    });
}

// Save custom command
async function saveCustomCommand(command) {
    try {
        const commands = await loadCommands();
        commands.customCommands.push(command);
        
        await fetch('/api/commands', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authToken}`
            },
            body: JSON.stringify({ customCommands: commands.customCommands })
        });
        
        // Refresh the welcome screen
        chatOutput.innerHTML = '';
        showWelcomeMessage();
    } catch (error) {
        console.error('Failed to save command:', error);
    }
}

// Delete custom command
async function deleteCustomCommand(index) {
    try {
        const commands = await loadCommands();
        commands.customCommands.splice(index, 1);
        
        await fetch('/api/commands', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authToken}`
            },
            body: JSON.stringify({ customCommands: commands.customCommands })
        });
        
        // Refresh the welcome screen
        chatOutput.innerHTML = '';
        showWelcomeMessage();
    } catch (error) {
        console.error('Failed to delete command:', error);
    }
}

function addMessage(content, className = 'claude-message') {
    console.log('addMessage called with:', content, 'className:', className);
    
    const messageDiv = document.createElement('div');
    messageDiv.classList.add('message');
    messageDiv.classList.add(className);
    
    // Handle different content types
    if (typeof content === 'string') {
        messageDiv.textContent = content;
    } else if (content.type === 'tool_use') {
        messageDiv.classList.add('tool-message');
        
        // Create terminal-like command display
        const terminalDiv = document.createElement('div');
        terminalDiv.className = 'terminal-command';
        
        // Format the command based on the tool
        let commandStr = '';
        if (content.name === 'Bash') {
            commandStr = content.input.command || '';
            terminalDiv.innerHTML = `<span class="terminal-prompt">$</span> <span class="terminal-cmd">${escapeHtml(commandStr)}</span>`;
        } else if (content.name === 'Read') {
            commandStr = `cat ${content.input.file_path || ''}`;
            terminalDiv.innerHTML = `<span class="terminal-prompt">$</span> <span class="terminal-cmd">${escapeHtml(commandStr)}</span>`;
        } else if (content.name === 'Write') {
            commandStr = `echo "..." > ${content.input.file_path || ''}`;
            terminalDiv.innerHTML = `<span class="terminal-prompt">$</span> <span class="terminal-cmd">${escapeHtml(commandStr)}</span>`;
        } else if (content.name === 'Edit') {
            commandStr = `sed -i 's/.../.../g' ${content.input.file_path || ''}`;
            terminalDiv.innerHTML = `<span class="terminal-prompt">$</span> <span class="terminal-cmd">${escapeHtml(commandStr)}</span>`;
        } else if (content.name === 'Grep') {
            commandStr = `grep "${content.input.pattern || ''}" ${content.input.path || '.'}`;
            terminalDiv.innerHTML = `<span class="terminal-prompt">$</span> <span class="terminal-cmd">${escapeHtml(commandStr)}</span>`;
        } else if (content.name === 'LS') {
            commandStr = `ls ${content.input.path || '.'}`;
            terminalDiv.innerHTML = `<span class="terminal-prompt">$</span> <span class="terminal-cmd">${escapeHtml(commandStr)}</span>`;
        } else if (content.name === 'Glob') {
            commandStr = `find . -name "${content.input.pattern || ''}"`;
            terminalDiv.innerHTML = `<span class="terminal-prompt">$</span> <span class="terminal-cmd">${escapeHtml(commandStr)}</span>`;
        } else if (content.name === 'MultiEdit') {
            commandStr = `vim ${content.input.file_path || ''} # Multiple edits`;
            terminalDiv.innerHTML = `<span class="terminal-prompt">$</span> <span class="terminal-cmd">${escapeHtml(commandStr)}</span>`;
        } else if (content.name === 'WebSearch') {
            commandStr = `search "${content.input.query || ''}"`;
            terminalDiv.innerHTML = `<span class="terminal-prompt">🔍</span> <span class="terminal-cmd">${escapeHtml(commandStr)}</span>`;
        } else if (content.name === 'WebFetch') {
            commandStr = `curl ${content.input.url || ''}`;
            terminalDiv.innerHTML = `<span class="terminal-prompt">$</span> <span class="terminal-cmd">${escapeHtml(commandStr)}</span>`;
        } else {
            // Generic tool display
            terminalDiv.innerHTML = `<span class="terminal-prompt">⚡</span> <span class="terminal-tool">${escapeHtml(content.name)}</span>`;
            if (content.input && Object.keys(content.input).length > 0) {
                const argsDiv = document.createElement('div');
                argsDiv.className = 'terminal-args';
                argsDiv.textContent = JSON.stringify(content.input, null, 2);
                terminalDiv.appendChild(argsDiv);
            }
        }
        
        messageDiv.appendChild(terminalDiv);
    } else if (content.type === 'tool_result') {
        messageDiv.classList.add('tool-result');
        
        // Create terminal-like output display
        const outputDiv = document.createElement('div');
        outputDiv.className = 'terminal-output';
        
        // Add the output content
        const pre = document.createElement('pre');
        pre.textContent = content.content || '';
        outputDiv.appendChild(pre);
        
        messageDiv.appendChild(outputDiv);
    }
    
    chatOutput.appendChild(messageDiv);
    chatOutput.scrollTop = chatOutput.scrollHeight;
    return messageDiv;
}

// Generate project name from prompt
function generateProjectName(prompt) {
    // Extract key words from prompt
    const stopWords = ['create', 'build', 'make', 'develop', 'help', 'with', 'that', 'this', 
                      'please', 'could', 'would', 'should', 'need', 'want', 'like', 'from',
                      'using', 'based', 'simple', 'basic', 'new', 'app', 'application'];
    
    const words = prompt.toLowerCase()
        .replace(/[^a-z0-9\s]/g, '') // Remove special chars
        .split(/\s+/)
        .filter(word => word.length > 2) // Keep meaningful words
        .filter(word => !stopWords.includes(word));
    
    // Take first 2-3 meaningful words
    const projectWords = words.slice(0, 2);
    
    // If no meaningful words, use timestamp
    if (projectWords.length === 0) {
        return `project-${new Date().getTime()}`;
    }
    
    // Join words and add short timestamp for uniqueness (last 6 digits)
    const timestamp = new Date().getTime().toString().slice(-6);
    return projectWords.join('-') + '-' + timestamp;
}

function sendPrompt() {
    const prompt = chatInput.value.trim();
    if (!prompt || isProcessing) return;

    // Clear welcome message if it exists
    const welcomeMsg = chatOutput.querySelector('.welcome-message');
    if (welcomeMsg) {
        welcomeMsg.remove();
    }

    // Check if this is a new conversation and we have a selected repository
    const selectedRepo = repositoryDropdown.value;
    const isNewConversation = !conversationId;
    
    if (isNewConversation && selectedRepo) {
        // Generate project name from prompt
        const projectName = generateProjectName(prompt);
        
        // Set processing state
        isProcessing = true;
        isWaitingResponse = true;
        chatInput.disabled = true;
        updateSendButton();
        
        // Clear input
        chatInput.value = '';
        
        // Create new conversation first
        socket.emit('createConversation', (newConversationId) => {
            conversationId = newConversationId;
            // Update URL without page reload
            window.history.pushState({}, '', `/c/${conversationId}`);
            
            // Show cloning message
            addMessage(`Creating new project "${projectName}" from repository "${selectedRepo}"...`, 'system');
            
            // Clone repository with generated project name
            socket.emit('cloneRepository', {
                conversationId: conversationId,
                repository: selectedRepo,
                projectName: projectName
            });
            
            // Store the prompt to send after cloning
            window.pendingPrompt = prompt;
        });
    } else if (!conversationId) {
        // Create new conversation without cloning
        socket.emit('createConversation', (newConversationId) => {
            conversationId = newConversationId;
            // Update URL without page reload
            window.history.pushState({}, '', `/c/${conversationId}`);
            
            // Actually send the prompt
            sendPromptToServer(prompt);
        });
    } else {
        sendPromptToServer(prompt);
    }
}

function sendPromptToServer(prompt) {
    // Add user message
    addMessage(prompt, 'user-message');

    // Clear input
    chatInput.value = '';

    // Disable input while processing
    isProcessing = true;
    isWaitingResponse = true;
    chatInput.disabled = true;
    updateSendButton();

    // Reset current messages array
    currentMessages = [];

    // Send prompt to server
    socket.emit('sendPrompt', prompt);
}

// Handle real-time output
socket.on('output', (data) => {
    // Try to parse JSON output from claude stream-json format
    try {
        const lines = data.trim().split('\n');
        lines.forEach(line => {
            if (line.trim()) {
                const json = JSON.parse(line);
                
                // Handle different types of Claude stream-json output
                if (json.type === 'assistant' && json.message && json.message.content) {
                    // Process each content item in the assistant message
                    json.message.content.forEach(content => {
                        if (content.type === 'text') {
                            // Add text message
                            addMessage(content.text, 'claude-message');
                        } else if (content.type === 'tool_use') {
                            // Add tool use message
                            addMessage(content, 'claude-message');
                        }
                    });
                } else if (json.type === 'user' && json.message && json.message.content) {
                    // Handle tool results from user messages
                    json.message.content.forEach(content => {
                        if (content.type === 'tool_result') {
                            console.log('Received tool_result:', content);
                            addMessage(content, 'claude-message');
                        }
                    });
                } else if (json.type === 'result' && json.result) {
                    // Check if this is a permission request
                    if (json.result.includes('permission') && json.result.includes('tool')) {
                        addMessage(`⚠️ ${json.result}\n\nNote: Common tools have been pre-approved for this session.`, 'system-message');
                    } else {
                        // Skip other result messages as they duplicate content
                        console.log('Result:', json.result);
                    }
                } else if (json.type === 'tool_message') {
                    // Handle tool_message type
                    console.log('Tool message:', json);
                    if (json.content) {
                        addMessage(json.content, 'tool-result');
                    }
                } else if (json.type === 'system') {
                    // Log system messages for debugging
                    console.log('System message:', json);
                    if (json.message && json.message.includes('Process stopped by user')) {
                        addMessage(json.message, 'system-message');
                    }
                } else if (json.type === 'error') {
                    // Display errors
                    addMessage(`Error: ${json.message || JSON.stringify(json)}`, 'error-message');
                } else {
                    // Log any unhandled message types
                    console.log('Unhandled message type:', json.type, json);
                }
            }
        });
    } catch (e) {
        // If not JSON, log error but don't display raw data
        console.error('Failed to parse JSON:', e, 'Data:', data);
    }
    chatOutput.scrollTop = chatOutput.scrollHeight;
});

// Handle errors
socket.on('error', (error) => {
    console.error('Socket error received:', error);
    // Handle error object from cloning
    if (error && error.message) {
        addMessage(error.message, 'error-message');
    } else if (error === 'No conversation ID set') {
        addMessage('Connection lost. Reconnecting...', 'error-message');
        // Try to rejoin the conversation
        if (conversationId) {
            socket.emit('joinConversation', conversationId);
            // Retry sending the last message if there was one
            setTimeout(() => {
                addMessage('Reconnected. Please try sending your message again.', 'system-message');
            }, 100);
        }
    } else {
        addMessage(`Error: ${error}`, 'error-message');
    }
    
    isProcessing = false;
    isWaitingResponse = false;
    chatInput.disabled = false;
    updateSendButton();
});

// Handle completion
socket.on('complete', (code) => {
    isProcessing = false;
    isWaitingResponse = false;
    chatInput.disabled = false;
    updateSendButton();
    chatInput.focus();
});

// Handle repository cloned event
socket.on('repositoryCloned', ({ repository, projectName, path }) => {
    // Update working directory after successful cloning
    const projectPath = `./projects/${projectName}`;
    workingDirectoryInput.value = projectPath;
    
    // Set working directory for the conversation
    socket.emit('setWorkingDirectory', {
        conversationId,
        workingDirectory: projectPath
    }, (response) => {
        if (response.error) {
            console.error('Error setting working directory:', response.error);
            addMessage(`Error setting working directory: ${response.error}`, 'error');
            // Re-enable input on error
            isProcessing = false;
            isWaitingResponse = false;
            chatInput.disabled = false;
            updateSendButton();
        } else {
            addMessage(`Repository "${repository}" successfully cloned to "${projectPath}". Working directory updated.`, 'system');
            
            // Send the pending prompt after successful cloning and directory setup
            if (window.pendingPrompt) {
                const prompt = window.pendingPrompt;
                window.pendingPrompt = null; // Clear pending prompt
                
                // Send the prompt to Claude
                sendPromptToServer(prompt);
            } else {
                // Re-enable input if no pending prompt
                isProcessing = false;
                isWaitingResponse = false;
                chatInput.disabled = false;
                updateSendButton();
            }
        }
    });
});

// Function to update send/stop button
function updateSendButton() {
    if (isWaitingResponse) {
        sendButton.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="4" y="4" width="8" height="8" fill="currentColor"/></svg> Stop';
        sendButton.classList.add('stop-button');
        sendButton.disabled = false;
    } else {
        sendButton.innerHTML = 'Send';
        sendButton.classList.remove('stop-button');
        sendButton.disabled = isProcessing || !chatInput.value.trim();
    }
}

// Function to stop current prompt
function stopPrompt() {
    socket.emit('stopPrompt');
    isWaitingResponse = false;
    isProcessing = false;
    chatInput.disabled = false;
    updateSendButton();
}

// Event listeners
sendButton.addEventListener('click', () => {
    if (isWaitingResponse) {
        stopPrompt();
    } else {
        sendPrompt();
    }
});

chatInput.addEventListener('input', () => {
    if (!isWaitingResponse) {
        updateSendButton();
    }
});

chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (isWaitingResponse) {
            stopPrompt();
        } else {
            sendPrompt();
        }
    }
});

// New chat button
const newChatButton = document.getElementById('newChatButton');
newChatButton.addEventListener('click', () => {
    if (confirm('Start a new conversation? Current conversation will be preserved.')) {
        window.location.href = '/';
    }
});

// Claude Chat logo click handler
const chatLogo = document.querySelector('.chat-header h2');
chatLogo.addEventListener('click', () => {
    window.location.href = '/';
});

// Logout button
const logoutButton = document.getElementById('logoutButton');
logoutButton.addEventListener('click', async () => {
    try {
        await fetch('/api/logout', { 
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${authToken}`
            }
        });
        localStorage.removeItem('authToken');
        window.location.href = '/login';
    } catch (error) {
        console.error('Logout failed:', error);
        // Force logout anyway
        localStorage.removeItem('authToken');
        window.location.href = '/login';
    }
});

// Working directory button
setDirectoryButton.addEventListener('click', async () => {
    const newDirectory = workingDirectoryInput.value.trim();
    if (!newDirectory) {
        alert('Please enter a directory path');
        return;
    }
    
    if (!conversationId) {
        // Create conversation first if it doesn't exist
        socket.emit('createConversation', (newConversationId) => {
            conversationId = newConversationId;
            window.history.pushState({}, '', `/c/${conversationId}`);
            setWorkingDirectory(newDirectory);
        });
    } else {
        setWorkingDirectory(newDirectory);
    }
});

// Function to set working directory
function setWorkingDirectory(directory) {
    socket.emit('setWorkingDirectory', { 
        conversationId, 
        workingDirectory: directory 
    }, (response) => {
        if (response.error) {
            alert(`Error: ${response.error}`);
        } else {
            // Show success message
            const systemMessage = document.createElement('div');
            systemMessage.className = 'message system-message';
            const action = response.created ? 'created and set to' : 'set to';
            systemMessage.innerHTML = `<strong>System:</strong> Working directory ${action}: ${escapeHtml(response.workingDirectory)}`;
            chatOutput.appendChild(systemMessage);
            chatOutput.scrollTop = chatOutput.scrollHeight;
        }
    });
}

// Load repositories on page load
async function loadRepositories() {
    try {
        const response = await fetch('/api/repositories', {
            headers: {
                'Authorization': `Bearer ${authToken}`
            }
        });
        
        if (!response.ok) throw new Error('Failed to load repositories');
        
        const data = await response.json();
        const { repositories } = data;
        
        // Store repository data
        repositoriesData = {};
        repositories.forEach(repo => {
            repositoriesData[repo.name] = repo;
        });
        
        // Clear existing options
        repositoryDropdown.innerHTML = '<option value="">Select a repository...</option>';
        
        // Add repository options
        repositories.forEach(repo => {
            const option = document.createElement('option');
            option.value = repo.name;
            option.textContent = repo.name;
            repositoryDropdown.appendChild(option);
        });
        
        // Restore preferred repository if saved
        const preferredRepo = localStorage.getItem('preferredRepository');
        if (preferredRepo && repositories.some(repo => repo.name === preferredRepo)) {
            repositoryDropdown.value = preferredRepo;
            // Load branches for the preferred repository
            loadBranches(preferredRepo);
        }
    } catch (error) {
        console.error('Error loading repositories:', error);
    }
}

// Load branches for selected repository
function loadBranches(repoName) {
    const repo = repositoriesData[repoName];
    if (!repo || !repo.branches) {
        // Hide branch dropdown if no branches
        branchDropdown.style.display = 'none';
        branchLabel.style.display = 'none';
        return;
    }
    
    // Clear existing options
    branchDropdown.innerHTML = '<option value="">Select a branch...</option>';
    
    // Add branch options
    repo.branches.forEach(branch => {
        const option = document.createElement('option');
        option.value = branch;
        option.textContent = branch;
        if (branch === repo.currentBranch) {
            option.textContent += ' (current)';
        }
        branchDropdown.appendChild(option);
    });
    
    // Select current branch by default
    if (repo.currentBranch) {
        branchDropdown.value = repo.currentBranch;
    }
    
    // Show branch dropdown
    branchDropdown.style.display = 'inline-block';
    branchLabel.style.display = 'inline-block';
    
    // Restore preferred branch if saved
    const preferredBranch = localStorage.getItem(`preferredBranch_${repoName}`);
    if (preferredBranch && repo.branches.includes(preferredBranch)) {
        branchDropdown.value = preferredBranch;
        // Switch to preferred branch if different from current
        if (preferredBranch !== repo.currentBranch) {
            switchBranch(repoName, preferredBranch);
        }
    }
}

// Switch branch in repository
async function switchBranch(repoName, branchName) {
    try {
        const response = await fetch(`/api/repositories/${encodeURIComponent(repoName)}/switch-branch`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${authToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ branch: branchName })
        });
        
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to switch branch');
        }
        
        const result = await response.json();
        console.log(result.message);
        
        // Update current branch in local data
        if (repositoriesData[repoName]) {
            repositoriesData[repoName].currentBranch = branchName;
        }
    } catch (error) {
        console.error('Error switching branch:', error);
        alert(`Failed to switch branch: ${error.message}`);
    }
}

// Handle clone repository button
cloneRepoButton.addEventListener('click', async () => {
    const selectedRepo = repositoryDropdown.value;
    const projectName = projectNameInput.value.trim();
    
    if (!selectedRepo) {
        alert('Please select a repository');
        return;
    }
    
    // Save selected repository as preferred choice
    localStorage.setItem('preferredRepository', selectedRepo);
    
    if (!projectName) {
        alert('Please enter a project name');
        return;
    }
    
    const projectPath = `./projects/${projectName}`;
    
    // Function to clone the repository
    const cloneRepo = (convId) => {
        const selectedBranch = branchDropdown.value;
        socket.emit('cloneRepository', {
            conversationId: convId,
            repository: selectedRepo,
            projectName: projectName,
            branch: selectedBranch || null
        });
        
        // Also update the working directory
        socket.emit('setWorkingDirectory', {
            conversationId: convId,
            workingDirectory: projectPath
        });
        
        // Update the working directory input
        workingDirectoryInput.value = projectPath;
        
        // Clear the form
        repositoryDropdown.value = '';
        projectNameInput.value = '';
        
        // Show cloning message
        addMessage(`Cloning repository "${selectedRepo}" to "${projectPath}"...`, 'system');
    };
    
    if (!conversationId) {
        // Create new conversation if it doesn't exist
        socket.emit('createConversation', (newConversationId) => {
            conversationId = newConversationId;
            window.history.pushState({}, '', `/c/${conversationId}`);
            cloneRepo(conversationId);
        });
    } else {
        cloneRepo(conversationId);
    }
});

// Repositories modal functionality
const repositoriesModal = document.getElementById('repositoriesModal');
const showRepositoriesButton = document.getElementById('showRepositoriesButton');
const closeModal = document.querySelector('.close');
const repositoriesList = document.getElementById('repositoriesList');

// Show repositories modal
showRepositoriesButton.addEventListener('click', async () => {
    try {
        // Load both repositories and projects in parallel
        const [repoResponse, projectsResponse] = await Promise.all([
            fetch('/api/repositories', {
                headers: { 'Authorization': `Bearer ${authToken}` }
            }),
            fetch('/api/projects', {
                headers: { 'Authorization': `Bearer ${authToken}` }
            })
        ]);
        
        if (!repoResponse.ok || !projectsResponse.ok) {
            throw new Error('Failed to load data');
        }
        
        const repoData = await repoResponse.json();
        const projectsData = await projectsResponse.json();
        const { repositories } = repoData;
        const { projects } = projectsData;
        
        // Clear existing list
        repositoriesList.innerHTML = '';
        
        // Add repositories section
        if (repositories.length > 0) {
            const repoSection = document.createElement('div');
            repoSection.innerHTML = '<h4 style="color: #c9d1d9; margin-bottom: 12px;">Available Repositories</h4>';
            repositoriesList.appendChild(repoSection);
            
            repositories.forEach(repo => {
                const repoName = repo.name || repo;
                const lastModified = repo.lastModified ? new Date(repo.lastModified).toLocaleDateString() : '';
                
                const repoItem = document.createElement('div');
                repoItem.className = 'repository-item';
                repoItem.innerHTML = `
                    <div class="repository-name">${repoName}</div>
                    <div class="repository-path">./repositories/${repoName}</div>
                    ${lastModified ? `<div style="color: #8b949e; font-size: 12px; margin-top: 4px;">Last modified: ${lastModified}</div>` : ''}
                `;
                
                // Click to open repository session
                repoItem.addEventListener('click', () => {
                    // Close modal
                    repositoriesModal.style.display = 'none';
                    
                    // Clear current conversation
                    chatHistory.innerHTML = '';
                    conversationId = null;
                    
                    // Set working directory to repository path
                    const repoPath = `./repositories/${repoName}`;
                    workingDirectoryInput.value = repoPath;
                    
                    // Create new conversation for this repository
                    socket.emit('createConversation', (newConversationId) => {
                        conversationId = newConversationId;
                        window.history.pushState({}, '', `/c/${conversationId}`);
                        
                        // Set working directory for the conversation
                        socket.emit('setWorkingDirectory', {
                            conversationId,
                            workingDirectory: repoPath
                        });
                        
                        // Send initial prompt to open the project
                        const prompt = `./repositories/${repoName}/claude`;
                        userInput.value = prompt;
                        sendPrompt();
                    });
                });
                
                repositoriesList.appendChild(repoItem);
            });
        }
        
        // Add projects section
        if (projects.length > 0) {
            const projectSection = document.createElement('div');
            projectSection.innerHTML = '<h4 style="color: #c9d1d9; margin-top: 24px; margin-bottom: 12px;">Your Projects</h4>';
            repositoriesList.appendChild(projectSection);
            
            projects.forEach(project => {
                const projectName = project.name || project;
                const lastModified = project.lastModified ? new Date(project.lastModified).toLocaleDateString() : '';
                
                const projectItem = document.createElement('div');
                projectItem.className = 'repository-item';
                projectItem.innerHTML = `
                    <div class="repository-name">${projectName}</div>
                    <div class="repository-path">./projects/${projectName}</div>
                    ${lastModified ? `<div style="color: #8b949e; font-size: 12px; margin-top: 4px;">Last modified: ${lastModified}</div>` : ''}
                `;
                
                // Click to switch to project
                projectItem.addEventListener('click', () => {
                    // Close modal
                    repositoriesModal.style.display = 'none';
                    
                    // Set working directory to project path
                    const projectPath = project.path || `./projects/${projectName}`;
                    workingDirectoryInput.value = projectPath;
                    
                    // If we have an active conversation, update its working directory
                    if (conversationId) {
                        socket.emit('setWorkingDirectory', {
                            conversationId,
                            workingDirectory: projectPath
                        }, (response) => {
                            if (response.error) {
                                console.error('Error setting working directory:', response.error);
                                addMessage(`Error setting working directory: ${response.error}`, 'error');
                            } else {
                                addMessage(`Switched to project: ${projectName} (${projectPath})`, 'system');
                            }
                        });
                    } else {
                        // No active conversation, create one
                        socket.emit('createConversation', (newConversationId) => {
                            conversationId = newConversationId;
                            window.history.pushState({}, '', `/c/${conversationId}`);
                            
                            // Set working directory for the conversation
                            socket.emit('setWorkingDirectory', {
                                conversationId,
                                workingDirectory: projectPath
                            }, (response) => {
                                if (response.error) {
                                    console.error('Error setting working directory:', response.error);
                                    addMessage(`Error setting working directory: ${response.error}`, 'error');
                                } else {
                                    addMessage(`Opened project: ${projectName} (${projectPath})`, 'system');
                                }
                            });
                        });
                    }
                });
                
                repositoriesList.appendChild(projectItem);
            });
        }
        
        // Show empty state if no repositories or projects
        if (repositories.length === 0 && projects.length === 0) {
            repositoriesList.innerHTML = '<p style="color: #8b949e; text-align: center;">No repositories or projects found</p>';
        }
        
        // Show modal
        repositoriesModal.style.display = 'block';
    } catch (error) {
        console.error('Error loading repositories:', error);
        addMessage('Failed to load repositories', 'error');
    }
});

// Close modal when clicking X
closeModal.addEventListener('click', () => {
    repositoriesModal.style.display = 'none';
});

// Close modal when clicking outside
window.addEventListener('click', (event) => {
    if (event.target === repositoriesModal) {
        repositoriesModal.style.display = 'none';
    }
});

// Save repository selection when dropdown changes
repositoryDropdown.addEventListener('change', () => {
    const selectedRepo = repositoryDropdown.value;
    if (selectedRepo) {
        localStorage.setItem('preferredRepository', selectedRepo);
        loadBranches(selectedRepo);
    } else {
        // Hide branch dropdown if no repository selected
        branchDropdown.style.display = 'none';
        branchLabel.style.display = 'none';
    }
});

// Handle branch dropdown change
branchDropdown.addEventListener('change', () => {
    const selectedRepo = repositoryDropdown.value;
    const selectedBranch = branchDropdown.value;
    
    if (selectedRepo && selectedBranch) {
        localStorage.setItem(`preferredBranch_${selectedRepo}`, selectedBranch);
        switchBranch(selectedRepo, selectedBranch);
    }
});

// Initialize conversation on load
initializeConversation();
loadRepositories();

// Focus input on load
chatInput.focus();