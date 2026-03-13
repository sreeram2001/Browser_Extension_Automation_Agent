# Nova Sonic Voice Assistant

A real-time voice assistant web app powered by [Amazon Nova Sonic](https://aws.amazon.com/bedrock/) on Amazon Bedrock. Talk to it naturally through your browser — it listens, responds with speech, and can take actions on your behalf.

## Features

- **Voice-to-voice conversation** — Bidirectional audio streaming with Amazon Nova Sonic for natural, real-time spoken dialogue
- **Wake word activation** — Say "Sonic" to start a conversation hands-free (uses Web Speech API)
- **Web grounding** — Answers questions about current events, news, and real-time info using Nova's grounding tool with citation support
- **Zoom meeting scheduling** — Create instant or scheduled Zoom meetings by voice using the Zoom Server-to-Server OAuth API
- **Live audio visualizer** — Visual feedback while you speak
- **Auto-silence detection** — Sessions end automatically after 10 seconds of inactivity

## Tech Stack

- **Backend:** Node.js, Express, WebSocket (`ws`)
- **AI Model:** Amazon Nova Sonic (`amazon.nova-sonic-v1:0`) via AWS Bedrock bidirectional streaming
- **Web Grounding:** Amazon Nova Premier via Bedrock Converse API
- **Frontend:** Vanilla JS with AudioWorklet for real-time mic capture and audio playback
- **Integrations:** Zoom Server-to-Server OAuth API

## Prerequisites

- AWS account with Bedrock access (Nova Sonic + Nova Premier enabled)
- AWS CLI configured with a named profile
- Zoom Server-to-Server OAuth app credentials (for meeting scheduling)
- Node.js 18+

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
PORT=3000
```

3. Start the server:

```bash
npm start
```

4. Open [http://localhost:3000](http://localhost:3000) in your browser, click "Enable Voice Assistant", and start talking.
