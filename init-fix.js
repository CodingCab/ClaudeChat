// This script will fix the initialization issue
// Add this at the beginning of app.js or load it separately

// Wait for DOM to be ready before executing any code
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeApp);
} else {
    // DOM is already ready
    initializeApp();
}

function initializeApp() {
    console.log('Initializing ClaudeChat application...');
    
    // Check if required elements exist
    const requiredElements = [
        'chatOutput',
        'chatInput', 
        'sendButton',
        'workingDirectory',
        'setDirectoryButton'
    ];
    
    let allElementsFound = true;
    for (const id of requiredElements) {
        const element = document.getElementById(id);
        if (!element) {
            console.error(`Required element not found: ${id}`);
            allElementsFound = false;
        }
    }
    
    if (!allElementsFound) {
        console.error('Cannot initialize app - missing required elements');
        return;
    }
    
    // Load the main app.js script
    const script = document.createElement('script');
    script.src = 'app.js';
    script.onload = () => {
        console.log('App.js loaded successfully');
    };
    script.onerror = () => {
        console.error('Failed to load app.js');
    };
    document.body.appendChild(script);
}