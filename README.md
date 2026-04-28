# Sonic — Voice-First Productivity Assistant

Talk to your workday. Meetings, tasks, calendar, and search — handled by voice so you stay in flow.

A real-time voice assistant powered by [Amazon Nova Sonic v2](https://aws.amazon.com/bedrock/) on Amazon Bedrock. Speak naturally through your browser — Sonic listens, responds with speech, and takes actions on your behalf.

## Demo

Check out the full demo and project details on Devpost: [Sonic — Voice Assistant](https://devpost.com/software/sonic-voice-assistant)

## Features

- **Voice-to-voice conversation** — Bidirectional audio streaming with Amazon Nova Sonic v2 for natural, real-time spoken dialogue
- **Wake word activation** — Say "Sonic" to start a conversation hands-free (uses Web Speech API)
- **Stop phrase** — Say "Stop Sonic" to end a session by voice
- **Web grounding** — Answers questions about current events, news, and real-time info using Nova's grounding tool with citation support
- **Zoom integration** — Create instant or scheduled Zoom meetings and list upcoming meetings by voice
- **Google Calendar** — List your upcoming events, add new events, and check your schedule
- **Calendar conflict detection** — Automatically warns about scheduling conflicts before creating events, with the option to override
- **Google Meet** — Create scheduled or instant Google Meet meetings with auto-join
- **Google Tasks** — Create tasks by voice, or automatically from meeting action items
- **Meeting summaries** — Fetch the latest Google Meet transcript from Drive, summarize it with AI, and optionally post to Slack
- **Reminders** — Set timed reminders that fire as browser notifications
- **YouTube** — Search for videos and summarize video transcripts by voice
- **Slack integration** — Post meeting summaries directly to a Slack channel via webhook
- **Live audio visualizer** — Visual feedback while you speak
- **Auto-silence detection** — Sessions end automatically after 10 seconds of inactivity
- **Tool keepalive** — Sessions stay alive during long-running tool calls (web search, API calls)

## Tech Stack

- **Backend:** Node.js, Express, WebSocket (`ws`)
- **AI Model:** Amazon Nova Sonic v2 (`amazon.nova-2-sonic-v1:0`) via AWS Bedrock bidirectional streaming
- **Web Grounding:** Amazon Nova Premier via Bedrock Converse API with LRU caching
- **Frontend:** Vanilla JS with AudioWorklet for real-time mic capture and audio playback
- **Integrations:** Zoom Server-to-Server OAuth, Google Calendar API, Google Drive API, Google Tasks API, YouTube Data API, Slack Webhooks

## Prerequisites

- AWS account with Bedrock access (Nova Sonic v2 + Nova Premier enabled in us-east-1)
- AWS CLI configured with a named profile
- Node.js 18+
- Zoom Server-to-Server OAuth app credentials (for Zoom features)
- Google Cloud project with Calendar, Drive, Tasks, and YouTube APIs enabled + OAuth credentials
- Slack incoming webhook URL (optional, for posting meeting summaries)
- YouTube Data API key (optional, for YouTube search)

## Setup

1. Clone the repo and install dependencies:

```bash
npm install
```

2. Create a `.env` file:

```env
AWS_REGION=us-east-1
AWS_PROFILE=your-profile-name
VOICE_ID=tiffany

ZOOM_ACCOUNT_ID=your-zoom-account-id
ZOOM_CLIENT_ID=your-zoom-client-id
ZOOM_CLIENT_SECRET=your-zoom-client-secret

SLACK_WEBHOOK_URL=your-slack-webhook-url
YOUTUBE_API_KEY=your-youtube-api-key

PORT=3000
```

3. Set up Google OAuth (one-time):

   - Download your `credentials.json` from the Google Cloud Console and place it in the project root
   - Run the auth flow:

   ```bash
   node google-auth.js
   ```

   - Authorize in the browser — this saves `google-token.json` for the server to use
   - Required scopes: Drive (readonly), Calendar, Tasks
   - The token auto-refreshes, so you only need to do this once

4. Start the server:

```bash
npm start
```

5. Open [http://localhost:3000](http://localhost:3000) in your browser, click "Enable Voice Assistant", and start talking.

## Voice Commands

| Category | Examples |
|---|---|
| **Calendar** | "What's on my calendar today?", "Am I free tomorrow afternoon?", "Show my schedule for the next 3 days" |
| **Add events** | "Add a dentist appointment tomorrow at 2pm", "Put a team lunch on my calendar Friday at noon" |
| **Google Meet** | "Start a Google Meet", "Schedule a Google Meet for tomorrow at 10am" |
| **Zoom** | "Start a Zoom call", "Schedule a Zoom meeting for Friday at 3pm", "List my Zoom meetings" |
| **Tasks** | "Create a task to review the Q3 report", "Turn those action items into tasks" |
| **Reminders** | "Remind me in 10 minutes to call John", "Set a reminder at 3pm to take a break" |
| **Meeting notes** | "Summarize my last meeting", "Send the meeting summary to Slack" |
| **YouTube** | "Search YouTube for Node.js tutorials", "Summarize this video" |
| **Web search** | "What's the weather today?", "What's the latest news about AI?" |

## Architecture

```
Browser (mic) → WebSocket → Express Server → Nova Sonic v2 (bidirectional stream)
                                           → Nova Premier (web grounding)
                                           → Google APIs (Calendar, Drive, Tasks, Meet)
                                           → Zoom API
                                           → YouTube API
                                           → Slack Webhook
```

12 tools are registered with Nova Sonic's tool configuration. When the model decides to use a tool, the server executes it, sends results back into the stream, and the model speaks the response — all in real time.
