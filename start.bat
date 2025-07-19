@echo off
echo Starting Wellington Bus Synth...

REM Check if .env exists
if not exist "backend\.env" (
    echo No .env file found. Please copy backend\.env.example to backend\.env and add your Metlink API key
    pause
    exit /b 1
)

REM Check if node_modules exists
if not exist "backend\node_modules" (
    echo Installing dependencies...
    cd backend
    npm install
    if errorlevel 1 (
        echo Failed to install dependencies
        pause
        exit /b 1
    )
    cd ..
)

REM Start the server
echo Starting server...
cd backend
npm start
pause