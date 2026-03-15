# Nova Sonic Voice Assistant

A real-time voice assistant web app powered by [Amazon Nova Sonic](https://aws.amazon.com/bedrock/) on Amazon Bedrock. Talk to it naturally through your browser — it listens, responds with speech, and can take actions on your behalf.

## Features

- **Voice-to-voice conversation** — Bidirectional audio streaming with Amazon Nova Sonic for natural, real-time spoken dialogue
- **Wake word activation** — Say "Sonic" to start a conversation hands-free (uses Web Speech API)
- **Web grounding** — Answers questions about current events, news, and real-time info using Nova's grounding tool with citation support
- **Zoom integration** — Create instant or scheduled Zoom meetings and list upcoming meetings by voice
- **Google Calendar** — List your upcoming events, add new events, and check your schedule by voice
- **Google Calendar conflict detection** — Automatically warns you about scheduling conflicts before creating events, with the option to override
- **Google Meet** — Create Google Meet meetings with calendar events and optional attendee invites
- **Meeting summaries** — Fetch the latest Google Meet transcript from Google Drive, summarize it with AI, and optionally post to Slack
- **Slack integration** — Post meeting summaries directly to a Slack channel via webhook
- **Live audio visualizer** — Visual feedback while you speak
- **Auto-silence detection** — Sessions end automatically after 10 seconds of inactivity

## Tech Stack

- **Backend:** Node.js, Express, WebSocket (`ws`)
- **AI Model:** Amazon Nova Sonic (`amazon.nova-sonic-v1:0`) via AWS Bedrock bidirectional streaming
- **Web Grounding:** Amazon Nova Premier via Bedrock Converse API
- **Frontend:** Vanilla JS with AudioWorklet for real-time mic capture and audio playback
- **Integrations:** Zoom Server-to-Server OAuth, Google Calendar API, Google Drive API, Slack Webhooks

## Prerequisites

- AWS account with Bedrock access (Nova Sonic + Nova Premier enabled)
- AWS CLI configured with a named profile
- Node.js 18+
- Zoom Server-to-Server OAuth app credentials (for Zoom features)
- Google Cloud project with Calendar and Drive APIs enabled + OAuth credentials (for Google features)
- Slack incoming webhook URL (optional, for posting meeting summaries)

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

SLACK_WEBHOOK_URL=your-slack-webhook-url-here

PORT=3000
```

3. Set up Google OAuth (one-time):

   - Download your `credentials.json` from the Google Cloud Console and place it in the project root
   - Run the auth flow:

   ```bash
   node google-auth.js
   ```

   - Authorize in the browser — this saves `google-token.json` for the server to use
   - The token auto-refreshes, so you only need to do this once

4. Start the server:

```bash
npm start
```

5. Open [http://localhost:3000](http://localhost:3000) in your browser, click "Enable Voice Assistant", and start talking.

## Voice Commands

Here are some things you can say:

| Category | Examples |
|---|---|
| **Calendar** | "What's on my calendar today?", "Am I free tomorrow afternoon?", "Show my schedule for the next 3 days" |
| **Add events** | "Add a dentist appointment tomorrow at 2pm", "Put a team lunch on my calendar Friday at noon" |
| **Google Meet** | "Schedule a Google Meet for tomorrow at 10am", "Create a Google Meet called project sync" |
| **Zoom** | "Start a Zoom call", "Schedule a Zoom meeting for Friday at 3pm", "List my Zoom meetings" |
| **Meeting notes** | "Summarize my last meeting", "Send the meeting summary to Slack" |
| **General** | "What's the weather today?", "What's the latest news about AI?" |
