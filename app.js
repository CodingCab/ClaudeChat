const socket = io();

const chatOutput = document.getElementById('chatOutput');
const chatInput = document.getElementById('chatInput');
const sendButton = document.getElementById('sendButton');

let isProcessing = false;
let currentMessages = [];
let conversationId = null;

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
        const response = await fetch(`/api/conversation/${id}`);
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
                            addMessage(content, 'claude-message');
                        }
                    });
                }
            });
        }
    });
}

// Show welcome message
function showWelcomeMessage() {
    const welcomeDiv = document.createElement('div');
    welcomeDiv.className = 'welcome-message';
    welcomeDiv.innerHTML = `
        <h3>Welcome to Claude UI! 👋</h3>
        <p>Start a conversation by typing a message below.</p>
    `;
    chatOutput.appendChild(welcomeDiv);
}

function addMessage(content, className = 'claude-message') {
    const messageDiv = document.createElement('div');
    messageDiv.classList.add('message');
    messageDiv.classList.add(className);
    
    // Handle different content types
    if (typeof content === 'string') {
        messageDiv.textContent = content;
    } else if (content.type === 'tool_use') {
        messageDiv.classList.add('tool-message');
        messageDiv.innerHTML = `<strong>🔧 Using tool: ${content.name}</strong>`;
        if (content.input) {
            const pre = document.createElement('pre');
            pre.textContent = JSON.stringify(content.input, null, 2);
            messageDiv.appendChild(pre);
        }
    } else if (content.type === 'tool_result') {
        messageDiv.classList.add('tool-result');
        messageDiv.innerHTML = `<strong>📋 Tool result:</strong>`;
        const pre = document.createElement('pre');
        pre.textContent = content.content;
        messageDiv.appendChild(pre);
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
    chatInput.disabled = true;
    sendButton.disabled = true;

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
                } else if (json.type === 'system') {
                    // Log system messages for debugging
                    console.log('System message:', json);
                } else if (json.type === 'error') {
                    // Display errors
                    addMessage(`Error: ${json.message || JSON.stringify(json)}`, 'error-message');
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
    chatInput.disabled = false;
    sendButton.disabled = false;
});

// Handle completion
socket.on('complete', (code) => {
    isProcessing = false;
    chatInput.disabled = false;
    sendButton.disabled = false;
    chatInput.focus();
});

// Event listeners
sendButton.addEventListener('click', sendPrompt);

chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendPrompt();
    }
});

// New chat button
const newChatButton = document.getElementById('newChatButton');
newChatButton.addEventListener('click', () => {
    if (confirm('Start a new conversation? Current conversation will be preserved.')) {
        window.location.href = '/';
    }
});

// Initialize conversation on load
initializeConversation();

// Focus input on load
chatInput.focus();