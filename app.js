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

const chatOutput = document.getElementById('chatOutput');
const chatInput = document.getElementById('chatInput');
const sendButton = document.getElementById('sendButton');

let isProcessing = false;
let currentMessages = [];
let conversationId = null;
let isWaitingResponse = false; // Track if we're waiting for Claude's response

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

function sendPrompt() {
    const prompt = chatInput.value.trim();
    if (!prompt || isProcessing) return;

    // Clear welcome message if it exists
    const welcomeMsg = chatOutput.querySelector('.welcome-message');
    if (welcomeMsg) {
        welcomeMsg.remove();
    }

    // Create new conversation if needed
    if (!conversationId) {
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
    addMessage(`Error: ${error}`, 'error-message');
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

// Initialize conversation on load
initializeConversation();

// Focus input on load
chatInput.focus();