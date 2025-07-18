// Get auth token from localStorage
let authToken = localStorage.getItem('authToken');
if (!authToken) {
    window.location.href = '/login?redirect=' + encodeURIComponent(window.location.pathname);
}

// Initialize socket early since it doesn't depend on DOM
const socket = io({
    auth: {
        token: authToken
    }
});

// Global variables that don't depend on DOM
let isProcessing = false;
let currentMessages = [];
let conversationId = null;
let isWaitingResponse = false;
let repositoriesData = {};

// DOM element variables - will be initialized after DOM loads
let chatOutput, chatInput, sendButton, workingDirectoryInput, setDirectoryButton;
let repositoryDropdown, branchDropdown, branchLabel, projectNameInput, cloneRepoButton;
let newChatButton, logoutButton, repositoriesModal, showRepositoriesButton, closeModal;
let systemPromptsModal, systemPromptsButton, systemPromptInput, setPromptButton;
let savePromptButton, clearPromptButton;

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

// Wait for DOM to be ready
document.addEventListener('DOMContentLoaded', () => {
    console.log('DOM loaded, initializing ClaudeChat...');
    
    // Initialize DOM elements
    chatOutput = document.getElementById('chatOutput');
    chatInput = document.getElementById('chatInput');
    sendButton = document.getElementById('sendButton');
    workingDirectoryInput = document.getElementById('workingDirectory');
    setDirectoryButton = document.getElementById('setDirectoryButton');
    repositoryDropdown = document.getElementById('repositoryDropdown');
    branchDropdown = document.getElementById('branchDropdown');
    branchLabel = document.getElementById('branchLabel');
    projectNameInput = document.getElementById('projectName');
    cloneRepoButton = document.getElementById('cloneRepoButton');
    newChatButton = document.getElementById('newChatButton');
    logoutButton = document.getElementById('logoutButton');
    repositoriesModal = document.getElementById('repositoriesModal');
    showRepositoriesButton = document.getElementById('showRepositoriesButton');
    closeModal = document.querySelector('.close');
    systemPromptsModal = document.getElementById('systemPromptsModal');
    systemPromptsButton = document.getElementById('systemPromptsButton');
    systemPromptInput = document.getElementById('systemPromptInput');
    setPromptButton = document.getElementById('setPromptButton');
    savePromptButton = document.getElementById('savePromptButton');
    clearPromptButton = document.getElementById('clearPromptButton');
    
    // Check if all required elements exist
    const requiredElements = {
        chatOutput, chatInput, sendButton, workingDirectoryInput, setDirectoryButton,
        repositoryDropdown, branchDropdown, projectNameInput, cloneRepoButton,
        newChatButton, logoutButton, showRepositoriesButton
    };
    
    for (const [name, element] of Object.entries(requiredElements)) {
        if (!element) {
            console.error(`Required element not found: ${name}`);
        }
    }
    
    // Initialize all functionality
    initializeEventListeners();
    initializeConversation();
    loadCommands();
    loadRepositories();
});

// Helper function to escape HTML
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Helper function to handle API requests with authentication
async function authenticatedFetch(url, options = {}) {
    // Get current token from localStorage
    const currentToken = localStorage.getItem('authToken');
    
    const mergedOptions = {
        ...options,
        headers: {
            'Authorization': `Bearer ${currentToken}`,
            ...options.headers
        }
    };
    
    const response = await fetch(url, mergedOptions);
    
    // Check if authentication failed
    if (response.status === 401) {
        localStorage.removeItem('authToken');
        window.location.href = '/login?redirect=' + encodeURIComponent(window.location.pathname);
        throw new Error('Authentication required');
    }
    
    return response;
}

// Initialize event listeners
function initializeEventListeners() {
    // Send button
    if (sendButton) {
        sendButton.addEventListener('click', () => {
            if (isWaitingResponse) {
                stopPrompt();
            } else {
                sendPrompt();
            }
        });
    }
    
    // Chat input
    if (chatInput) {
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
    }
    
    // New chat button
    if (newChatButton) {
        newChatButton.addEventListener('click', () => {
            if (confirm('Start a new conversation? Current conversation will be preserved.')) {
                window.location.href = '/';
            }
        });
    }
    
    // Claude Chat logo click handler
    const chatLogo = document.querySelector('.chat-header h2');
    if (chatLogo) {
        chatLogo.addEventListener('click', () => {
            window.location.href = '/';
        });
    }
    
    // Logout button
    if (logoutButton) {
        logoutButton.addEventListener('click', async () => {
            try {
                await authenticatedFetch('/api/logout', { 
                    method: 'POST'
                });
                localStorage.removeItem('authToken');
                window.location.href = '/login';
            } catch (error) {
                console.error('Logout failed:', error);
                alert('Failed to logout. Please try again.');
            }
        });
    }
    
    // Working directory button
    if (setDirectoryButton) {
        setDirectoryButton.addEventListener('click', async () => {
            const newDirectory = workingDirectoryInput.value.trim();
            if (!newDirectory) {
                alert('Please enter a working directory');
                return;
            }
            
            if (!conversationId) {
                await createNewConversation();
            }
            
            socket.emit('setWorkingDirectory', { 
                conversationId, 
                workingDirectory: newDirectory 
            }, (response) => {
                if (response.error) {
                    alert(`Failed to set working directory: ${response.error}`);
                } else {
                    console.log('Working directory set:', response.workingDirectory);
                    if (response.created) {
                        addMessage(`Created and set working directory: ${response.workingDirectory}`, 'system-message');
                    } else {
                        addMessage(`Set working directory: ${response.workingDirectory}`, 'system-message');
                    }
                }
            });
        });
    }
    
    // Repository dropdown
    if (repositoryDropdown) {
        repositoryDropdown.addEventListener('change', () => {
            const selectedRepo = repositoryDropdown.value;
            if (selectedRepo) {
                updateBranchDropdown(selectedRepo);
                projectNameInput.value = selectedRepo;
            }
        });
    }
    
    // Branch dropdown
    if (branchDropdown) {
        branchDropdown.addEventListener('change', () => {
            const selectedRepo = repositoryDropdown.value;
            const selectedBranch = branchDropdown.value;
            if (selectedRepo && selectedBranch && repositoriesData[selectedRepo]) {
                // You can add logic here if needed when branch changes
            }
        });
    }
    
    // Clone repository button
    if (cloneRepoButton) {
        cloneRepoButton.addEventListener('click', async () => {
            const selectedRepo = repositoryDropdown.value;
            const projectName = projectNameInput.value.trim();
            const selectedBranch = branchDropdown.value;
            
            if (!selectedRepo) {
                alert('Please select a repository');
                return;
            }
            
            if (!projectName) {
                alert('Please enter a project name');
                return;
            }
            
            if (!conversationId) {
                await createNewConversation();
            }
            
            cloneRepoButton.disabled = true;
            cloneRepoButton.textContent = 'Cloning...';
            
            socket.emit('cloneRepository', {
                conversationId,
                repository: selectedRepo,
                projectName: projectName,
                branch: selectedBranch || null
            });
        });
    }
    
    // Show repositories button
    if (showRepositoriesButton) {
        showRepositoriesButton.addEventListener('click', async () => {
            try {
                // Load both repositories and projects in parallel
                const [repoResponse, projectsResponse] = await Promise.all([
                    authenticatedFetch('/api/repositories'),
                    authenticatedFetch('/api/projects')
                ]);
                
                if (!repoResponse.ok || !projectsResponse.ok) {
                    throw new Error('Failed to load data');
                }
                
                const repoData = await repoResponse.json();
                const projectsData = await projectsResponse.json();
                
                // Display repositories and projects in modal
                displayRepositoriesModal(repoData.repositories || [], projectsData.projects || []);
            } catch (error) {
                console.error('Failed to load repositories:', error);
                alert('Failed to load repositories. Please try again.');
            }
        });
    }
    
    // Modal close button
    if (closeModal) {
        closeModal.addEventListener('click', () => {
            repositoriesModal.style.display = 'none';
        });
    }
    
    // Close modal when clicking outside
    window.addEventListener('click', (event) => {
        if (event.target === repositoriesModal) {
            repositoriesModal.style.display = 'none';
        }
        if (event.target === systemPromptsModal) {
            systemPromptsModal.style.display = 'none';
        }
    });
    
    // System prompts button
    if (systemPromptsButton) {
        systemPromptsButton.addEventListener('click', () => {
            loadSystemPrompts();
            systemPromptsModal.style.display = 'block';
        });
    }
    
    // System prompts modal close
    const systemPromptsCloseBtn = systemPromptsModal?.querySelector('.close');
    if (systemPromptsCloseBtn) {
        systemPromptsCloseBtn.addEventListener('click', () => {
            systemPromptsModal.style.display = 'none';
        });
    }
    
    // Set active prompt
    if (setPromptButton) {
        setPromptButton.addEventListener('click', async () => {
            const prompt = systemPromptInput.value.trim();
            if (prompt) {
                systemPromptsData.activePrompt = prompt;
                await saveSystemPrompts();
                updateSystemPromptsUI();
                alert('System prompt activated!');
            }
        });
    }
    
    // Save prompt to library
    if (savePromptButton) {
        savePromptButton.addEventListener('click', async () => {
            const prompt = systemPromptInput.value.trim();
            if (prompt && !systemPromptsData.savedPrompts.includes(prompt)) {
                systemPromptsData.savedPrompts.push(prompt);
                await saveSystemPrompts();
                updateSystemPromptsUI();
                alert('Prompt saved to library!');
            }
        });
    }
    
    // Clear active prompt
    if (clearPromptButton) {
        clearPromptButton.addEventListener('click', async () => {
            systemPromptsData.activePrompt = null;
            await saveSystemPrompts();
            updateSystemPromptsUI();
            systemPromptInput.value = '';
            alert('Active system prompt cleared!');
        });
    }
}

// The rest of your functions go here...
// (Copy all the remaining functions from the original app.js file)

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

// Create a new conversation
async function createNewConversation() {
    return new Promise((resolve) => {
        socket.emit('createConversation', (newConversationId) => {
            conversationId = newConversationId;
            
            // Update URL without reloading
            window.history.pushState({}, '', `/c/${conversationId}`);
            
            // Clear chat output and show fresh UI
            chatOutput.innerHTML = '';
            showWelcomeMessage();
            
            resolve(conversationId);
        });
    });
}

// Update send button state
function updateSendButton() {
    if (!sendButton || !chatInput) return;
    
    if (isWaitingResponse) {
        sendButton.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20"><rect x="6" y="6" width="4" height="12" fill="currentColor"/><rect x="14" y="6" width="4" height="12" fill="currentColor"/></svg> Stop';
        sendButton.classList.add('stop-button');
    } else {
        const hasContent = chatInput.value.trim().length > 0;
        sendButton.disabled = !hasContent;
        sendButton.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" fill="currentColor"/></svg> Send';
        sendButton.classList.remove('stop-button');
    }
}