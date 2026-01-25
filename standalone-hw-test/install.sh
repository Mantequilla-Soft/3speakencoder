#!/bin/bash
# Hardware Acceleration Test - Quick Install Script
# Works on Linux and macOS

set -e

echo "╔════════════════════════════════════════════════════════════╗"
echo "║   Hardware Acceleration Test - Installation                ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

# Check for Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed"
    echo "   Please install Node.js from https://nodejs.org"
    exit 1
fi

echo "✅ Node.js found: $(node --version)"

# Check for npm
if ! command -v npm &> /dev/null; then
    echo "❌ npm is not installed"
    exit 1
fi

echo "✅ npm found: $(npm --version)"

# Check for FFmpeg
if ! command -v ffmpeg &> /dev/null; then
    echo "⚠️  FFmpeg is not installed"
    echo "   The test will fail without FFmpeg"
    echo "   Install it from: https://ffmpeg.org/download.html"
    echo ""
    read -p "Continue anyway? (y/n): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
else
    echo "✅ FFmpeg found: $(ffmpeg -version | head -n 1)"
fi

echo ""
echo "📦 Installing dependencies..."
npm install

echo ""
echo "╔════════════════════════════════════════════════════════════╗"
echo "║   Installation Complete!                                   ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""
echo "🚀 Run the test with:"
echo "   npm start"
echo ""
echo "   or"
echo ""
echo "   npm test"
echo ""
