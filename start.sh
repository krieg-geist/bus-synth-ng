#!/bin/bash

echo "Starting Wellington Bus Synth..."

# Check if .env exists
if [ ! -f "./backend/.env" ]; then
    echo "No .env file found. Please copy backend/.env.example to backend/.env and add your Metlink API key"
    exit 1
fi

# Check if node_modules exists
if [ ! -d "./backend/node_modules" ]; then
    echo "Installing dependencies..."
    cd backend
    npm install
    if [ $? -ne 0 ]; then
        echo "Failed to install dependencies"
        exit 1
    fi
    cd ..
fi

# Start the server
echo "Starting server..."
cd backend
npm start