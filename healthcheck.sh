#!/bin/bash

# Health check script for ClaudeUI
# Checks if the service is listening on port 3000

# Check if port 3000 is listening
if lsof -i :3000 | grep -q LISTEN; then
    # Try to make a simple HTTP request
    if curl -s -o /dev/null -w "%{http_code}" http://localhost:3000 | grep -q "200\|302\|304"; then
        exit 0  # Success
    else
        echo "Port 3000 is listening but HTTP request failed"
        exit 1
    fi
else
    echo "Port 3000 is not listening"
    exit 1
fi