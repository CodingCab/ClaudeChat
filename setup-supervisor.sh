#!/bin/bash

# Setup script for running claude-chat-ui under supervisor

# Check if supervisor is installed
if ! command -v supervisord &> /dev/null; then
    echo "Supervisor is not installed. Installing..."
    if [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS
        brew install supervisor
    elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
        # Linux
        sudo apt-get update && sudo apt-get install -y supervisor || sudo yum install -y supervisor
    else
        echo "Unsupported OS. Please install supervisor manually."
        exit 1
    fi
fi

# Create log directory if it doesn't exist
sudo mkdir -p /var/log

# Copy supervisor config to appropriate location
if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS - Homebrew installs supervisor config in different location
    SUPERVISOR_CONF_DIR="/usr/local/etc/supervisor.d"
    sudo mkdir -p "$SUPERVISOR_CONF_DIR"
    sudo cp supervisord.conf "$SUPERVISOR_CONF_DIR/claude-chat-ui.ini"
else
    # Linux
    SUPERVISOR_CONF_DIR="/etc/supervisor/conf.d"
    sudo mkdir -p "$SUPERVISOR_CONF_DIR"
    sudo cp supervisord.conf "$SUPERVISOR_CONF_DIR/claude-chat-ui.conf"
fi

echo "Supervisor configuration installed."

# Reload supervisor configuration
sudo supervisorctl reread
sudo supervisorctl update

# Start the service
sudo supervisorctl start claude-chat-ui

echo "claude-chat-ui is now running under supervisor!"
echo ""
echo "Useful commands:"
echo "  sudo supervisorctl status               # Check status"
echo "  sudo supervisorctl restart claude-chat-ui  # Restart service"
echo "  sudo supervisorctl stop claude-chat-ui     # Stop service"
echo "  sudo supervisorctl tail -f claude-chat-ui  # View logs"