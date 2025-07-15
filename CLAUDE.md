# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ClaudeChat is a web-based chat interface for Claude CLI that provides a developer-friendly UI with conversation persistence, command management, and real-time communication.

## Core Architecture

### Backend (server.js)
- Express.js server with Socket.io for WebSocket communication
- Spawns Claude CLI processes with `--print --output-format stream-json --verbose` flags
- Manages conversation state using in-memory Map structures
- Supports Claude's `--resume` flag for session continuity
- **Special feature**: Path-based command execution - commands starting with `./folder/claude` will create the directory and run Claude from that location

### Frontend
- **app.js**: Handles WebSocket communication, command management, and UI updates
- **index.html**: Single-page application structure
- **styles.css**: GitHub-inspired dark theme with monospace fonts

### Key Architectural Decisions
1. **Stream-JSON parsing**: Claude's output is parsed line-by-line to extract different message types (assistant, tool_use, tool_result, system, error)
2. **Session management**: Claude session IDs are captured and stored to enable conversation resumption
3. **Command system**: Commands are loaded from `commands.json` and can be customized via the UI
4. **URL-based conversations**: Each conversation gets a unique ID accessible at `/c/{conversation-id}`

## Development Commands

```bash
# Start the development server
npm start

# The server runs on port 3000 by default
# Access at http://localhost:3000
```

## Key Implementation Details

### Claude CLI Integration
- Pre-approved tools: `LS,Read,Write,Edit,Bash,Grep,Glob,WebSearch,WebFetch`
- Working directory changes based on command prefix (e.g., `./newFolder/claude create app`)
- Stdin is used for prompt input instead of command arguments for reliability

### Message Handling Flow
1. User sends prompt via WebSocket
2. Server spawns Claude process with appropriate flags
3. Claude's stream-JSON output is forwarded to client in real-time
4. Client parses JSON and displays messages with appropriate styling
5. Session ID is captured for conversation continuity

### Command Management
- Default commands are stored in `commands.json`
- Custom commands can be added/deleted through the UI
- Commands execute immediately on click (no need to press send)
- Commands support icons (emojis) and descriptions

## Important File Locations
- Claude session management: `server.js` lines 15-18 (claudeSessions Map)
- Path-based execution: `server.js` lines 106-141
- Command loading/saving: `server.js` lines 34-55
- Message parsing: `app.js` lines 67-112
- Command UI management: `app.js` lines 76-220