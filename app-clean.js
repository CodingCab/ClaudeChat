// Get auth token from localStorage
let authToken = localStorage.getItem('authToken');
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

// DOM elements - will be initialized after DOM loads
let chatOutput, chatInput, sendButton, workingDirectoryInput, setDirectoryButton;
let repositoryDropdown, branchDropdown, branchLabel, projectNameInput, cloneRepoButton;
let repositoriesModal, showRepositoriesButton, closeModal, repositoriesList;
let systemPromptsModal, systemPromptsButton, systemPromptInput, setPromptButton;
let savePromptButton, clearPromptButton, activePromptDisplay, savedPromptsList;

let isProcessing = false;
let currentMessages = [];
let conversationId = null;
let isWaitingResponse = false; // Track if we're waiting for Claude's response
let repositoriesData = {}; // Store repository data including branches
let systemPromptsData = { activePrompt: null, savedPrompts: [] };

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

// Copy all the function definitions from the original file here...
// (All functions like initializeConversation, loadConversation, displayConversationHistory, etc.)

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    console.log('Initializing ClaudeChat...');
    
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
    
    // Initialize repositories modal elements
    repositoriesModal = document.getElementById('repositoriesModal');
    showRepositoriesButton = document.getElementById('showRepositoriesButton');
    closeModal = document.querySelector('.close');
    repositoriesList = document.getElementById('repositoriesList');
    
    // Initialize system prompts elements
    systemPromptsModal = document.getElementById('systemPromptsModal');
    systemPromptsButton = document.getElementById('systemPromptsButton');
    systemPromptInput = document.getElementById('systemPromptInput');
    setPromptButton = document.getElementById('setPromptButton');
    savePromptButton = document.getElementById('savePromptButton');
    clearPromptButton = document.getElementById('clearPromptButton');
    activePromptDisplay = document.getElementById('activePromptDisplay');
    savedPromptsList = document.getElementById('savedPromptsList');
    
    // Check for required elements
    if (!chatOutput || !chatInput || !sendButton) {
        console.error('Required elements not found!');
        return;
    }
    
    // Initialize event listeners and start the app
    initializeEventListeners();
    initializeModalEventListeners();
    initializeSystemPromptListeners();
    initializeConversation();
    loadRepositories();
    
    // Focus input on load
    if (chatInput) {
        chatInput.focus();
    }
});