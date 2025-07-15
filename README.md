# ClaudeChat

A web-based chat interface for Claude CLI that preserves conversations and provides a user-friendly UI for interacting with Claude.

## Features

- 💬 Real-time chat interface with Claude
- 🔧 Tool usage visualization (shows when Claude uses tools like file reading, web search, etc.)
- 📝 Conversation persistence with unique URLs
- 🔄 Session management - maintains context across messages
- 🎨 Clean, responsive UI with message bubbles
- ⚡ WebSocket-based real-time communication

## Prerequisites

- Node.js (v14 or higher)
- Claude CLI installed and configured
- npm or yarn package manager

## Installation

1. Clone the repository:
```bash
git clone https://github.com/CodingCab/ClaudeChat.git
cd ClaudeChat
```

2. Install dependencies:
```bash
npm install
```

3. Make sure Claude CLI is installed and accessible from your terminal:
```bash
claude --version
```

## Usage

1. Start the server:
```bash
npm start
```

2. Open your browser and navigate to:
```
http://localhost:3000
```

3. Start chatting with Claude! Each conversation gets a unique URL that you can bookmark or share.

## How It Works

- **Server**: Node.js/Express server with Socket.io for real-time communication
- **Claude Integration**: Uses Claude CLI with `--print --output-format stream-json --verbose` flags
- **Session Management**: Leverages Claude's built-in `--resume` flag to maintain conversation context
- **Tool Permissions**: Pre-approves common tools (LS, Read, Write, Edit, Bash, Grep, Glob, WebSearch, WebFetch)

## Project Structure

```
ClaudeChat/
├── server.js          # Express server with Socket.io and Claude integration
├── app.js            # Client-side JavaScript
├── index.html        # Main HTML file
├── styles.css        # CSS styles
├── package.json      # Node.js dependencies
└── README.md         # This file
```

## Configuration

The server automatically allows common Claude tools. To modify allowed tools, edit the `--allowedTools` parameter in `server.js`.

## License

MIT License - feel free to use this project for your own purposes.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.