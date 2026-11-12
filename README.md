# Chimik Connect Messaging Platform

A complete messaging platform prototype built with Node.js, Express, Socket.IO, and SQLite.

## Features

- User registration and login
- Persistent chat history with SQLite
- Real-time messaging using Socket.IO
- Contact list and chat interface
- Status updates
- Authenticated private image, video, audio, PDF, and document attachments
- Voice notes recorded with the browser MediaRecorder API
- Multi-media statuses with contact privacy and 24-hour expiry
- Face-auth simulation in browser
- Mobile-friendly responsive layout

## Quick Start

1. Install dependencies:
   npm install
2. Copy `.env.example` to `.env` and set `OPENAI_API_KEY` to your private OpenAI API key. Keep the key out of frontend files and source control. `OPENAI_MODEL` defaults to `gpt-5.5`.
3. Start the app:
   npm start
4. Open http://localhost:3000 in a browser

## API Overview

- POST /api/register
- POST /api/login
- GET /api/users
- GET /api/messages?userA=1&userB=2
- POST /api/messages
- GET /api/statuses
- POST /api/statuses

## Notes

The application keeps user and message data in a local SQLite file named `tavlik.db`.

Uploaded attachments are stored outside the publicly served project directory in `../tavlik-media` by default. Set `TAVLIK_MEDIA_DIR` to use another persistent storage location. Uploads are limited to 100 MB per file and are served through authenticated routes. Voice recording requires microphone permission and a secure browser context (HTTPS or localhost).

Cross-origin requests are restricted to `http://localhost:<PORT>` and `http://127.0.0.1:<PORT>` by default. Set `CHIMIC_ALLOWED_ORIGINS` to a comma-separated list of trusted origins when using a LAN address or deployed domain. Keep the existing `tavlik.db` path and `TAVLIK_MEDIA_DIR` on persistent storage when deploying; tests use temporary database and media paths.

The API uses authenticated sessions for user-scoped routes, Socket.IO authenticates with the session token, and HTTP security headers plus API/authentication rate limits are enabled. This remains a prototype: production still requires HTTPS, tested backups, configured trusted origins, and operational monitoring and session policies. No external service credentials are included.

Chimic AI uses the authenticated `POST /api/ai` endpoint and the OpenAI Responses API. Configure `OPENAI_API_KEY` and optionally `OPENAI_MODEL` in a private local `.env` file or your hosting provider's environment settings. AI requests are disabled when the account's AI assistant consent setting is off. OpenAI billing and an API key with access to the configured model are required.
