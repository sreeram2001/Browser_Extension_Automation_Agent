require("dotenv").config();
const express = require("express");
const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");
const path = require("path");
const {
    BedrockRuntimeClient,
    InvokeModelWithBidirectionalStreamCommand,
} = require("@aws-sdk/client-bedrock-runtime");
const { NodeHttp2Handler } = require("@smithy/node-http-handler");
const { fromIni } = require("@aws-sdk/credential-provider-ini");
const crypto = require("crypto");

const { ALL_TOOLS } = require("./tools/definitions");
const { handleToolUse } = require("./tools/handler");
const { restoreReminders, setActiveClients } = require("./services/reminders");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, "public")));

const REGION = process.env.AWS_REGION || "us-east-1";
const MODEL_ID = "amazon.nova-2-sonic-v1:0";
const GROUNDING_MODEL_ID = process.env.GROUNDING_MODEL_ID || "us.amazon.nova-premier-v1:0";
const AWS_PROFILE = process.env.AWS_PROFILE || "uoc";
const VOICE_ID = process.env.VOICE_ID || "tiffany";

const activeClients = new Set();
setActiveClients(activeClients);
restoreReminders();

function createBedrockClient() {
    const handler = new NodeHttp2Handler({
        requestTimeout: 300000,
        sessionTimeout: 300000,
        disableConcurrentStreams: false,
        maxConcurrentStreams: 20,
    });
    return new BedrockRuntimeClient({
        region: REGION,
        credentials: fromIni({ profile: AWS_PROFILE }),
        requestHandler: handler,
    });
}

const converseClient = new BedrockRuntimeClient({
    region: REGION,
    credentials: fromIni({ profile: AWS_PROFILE }),
});

function randomId() {
    return crypto.randomUUID();
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function getSystemPrompt() {
    const dateStr = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "America/Denver" });
    const timeStr = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Denver" });
    return `You are Sonic, a friendly voice assistant with web search, Zoom meeting, Google Calendar, Google Meet, Google Tasks, reminders, YouTube, and meeting summary capabilities. Your name is Sonic. Whenever the user says "Sonic", they are referring to you — do NOT search the web for "Sonic" or treat it as a query. Never use web_search for anything related to your own name or identity. Today's date is ${dateStr}. The current time is ${timeStr} MST. The user and you will engage in a spoken dialog exchanging the transcripts of a natural real-time conversation. Keep your responses short, generally two or three sentences for chatty scenarios. When the user asks about current events, news, weather, real-time information, or anything you're unsure about, use the web_search tool to look it up. Always mention your sources briefly when using search results. When the user asks to schedule or create a Zoom meeting, use the schedule_zoom_meeting tool. Always assume the user's timezone is MST (Mountain Standard Time, UTC-7) and convert times to ISO 8601 with the MST offset. Always use the current year when scheduling meetings. When the user wants to start an instant call or join a Zoom right now, use the instant_zoom_meeting tool. When the user asks to see or list their meetings, use the list_zoom_meetings tool. When the user asks about their calendar, schedule, what meetings they have, or whether they are free, use the list_google_calendar_events tool. When the user asks to add, create, or put an event on their calendar (that is not a Google Meet), use the add_google_calendar_event tool. When the user asks to create or schedule a Google Meet, use the create_google_meet tool. When the user wants to start an instant Google Meet or hop on a Google Meet right now, use the instant_google_meet tool — do NOT use the Zoom instant meeting tool for this. When the user asks to summarize a meeting, get meeting notes, or send a meeting summary to Slack, use the summarize_meeting tool. Ask if they want it posted to Slack. When the user asks to set a reminder, be reminded about something, or set a timer, use the set_reminder tool. If they say "remind me in X minutes", set minutes to X. If they say "remind me at 3pm", convert to ISO 8601 MST and use remind_at. When the user asks to find or search for a YouTube video, use the youtube_search tool. When the user asks to summarize a YouTube video or wants to know what a video is about, use the youtube_summarize tool. When the user asks to create tasks, add action items to their task list, turn meeting action items into tasks, or add a to-do, use the create_google_tasks tool. After summarizing a meeting, proactively ask if the user wants to create Google Tasks from the action items. Do not read out meeting links, IDs, or full URLs. Ask for a topic if the user doesn't provide one.`;
}

wss.on("connection", (ws) => {
    console.log("Client connected");
    activeClients.add(ws);

    let bedrockClient = createBedrockClient();
    let isActive = false;
    let promptName = randomId();
    let contentName = randomId();
    let audioContentName = randomId();
    let inputResolve = null;
    let inputQueue = [];

    function getNextInput() {
        return new Promise((resolve) => {
            if (inputQueue.length > 0) resolve(inputQueue.shift());
            else inputResolve = resolve;
        });
    }

    function pushInput(event) {
        if (inputResolve) {
            const r = inputResolve;
            inputResolve = null;
            r(event);
        } else {
            inputQueue.push(event);
        }
    }

    function makeEvent(event) {
        return { chunk: { bytes: Buffer.from(JSON.stringify({ event })) } };
    }

    function pushToolResult(toolUseId, responseJson) {
        const toolResultContentName = randomId();
        pushInput(makeEvent({
            contentStart: {
                promptName, contentName: toolResultContentName,
                interactive: false, type: "TOOL", role: "TOOL",
                toolResultInputConfiguration: {
                    toolUseId, type: "TEXT",
                    textInputConfiguration: { mediaType: "text/plain" },
                },
            },
        }));
        pushInput(makeEvent({
            toolResult: { promptName, contentName: toolResultContentName, content: responseJson },
        }));
        pushInput(makeEvent({
            contentEnd: { promptName, contentName: toolResultContentName },
        }));
    }

    async function* generateEvents() {
        yield makeEvent({ sessionStart: { inferenceConfiguration: { maxTokens: 1024, topP: 0.9, temperature: 0.7 } } });
        await sleep(50);

        yield makeEvent({
            promptStart: {
                promptName,
                textOutputConfiguration: { mediaType: "text/plain" },
                audioOutputConfiguration: {
                    mediaType: "audio/lpcm", sampleRateHertz: 24000, sampleSizeBits: 16,
                    channelCount: 1, voiceId: VOICE_ID, encoding: "base64", audioType: "SPEECH",
                },
                toolUseOutputConfiguration: { mediaType: "application/json" },
                toolConfiguration: { tools: ALL_TOOLS, toolChoice: { auto: {} } },
            },
        });
        await sleep(50);

        // System prompt
        yield makeEvent({
            contentStart: {
                promptName, contentName, type: "TEXT", interactive: true,
                role: "SYSTEM", textInputConfiguration: { mediaType: "text/plain" },
            },
        });
        await sleep(30);

        yield makeEvent({ textInput: { promptName, contentName, content: getSystemPrompt() } });
        await sleep(30);

        yield makeEvent({ contentEnd: { promptName, contentName } });
        await sleep(30);

        // Audio content start
        yield makeEvent({
            contentStart: {
                promptName, contentName: audioContentName, type: "AUDIO", interactive: true,
                role: "USER", audioInputConfiguration: {
                    mediaType: "audio/lpcm", sampleRateHertz: 16000, sampleSizeBits: 16,
                    channelCount: 1, audioType: "SPEECH", encoding: "base64",
                },
            },
        });
        await sleep(30);

        // Stream audio chunks
        while (isActive) {
            const event = await getNextInput();
            if (event === null) break;
            yield event;
        }

        yield makeEvent({ contentEnd: { promptName, contentName: audioContentName } });
        await sleep(30);
        yield makeEvent({ promptEnd: { promptName } });
        await sleep(30);
        yield makeEvent({ sessionEnd: {} });
    }

    async function startSession() {
        isActive = true;

        try {
            const command = new InvokeModelWithBidirectionalStreamCommand({
                modelId: MODEL_ID,
                body: generateEvents(),
            });

            const response = await bedrockClient.send(command);

            for await (const event of response.body) {
                if (!isActive) break;

                if (event.chunk?.bytes) {
                    try {
                        const text = new TextDecoder().decode(event.chunk.bytes);
                        const json = JSON.parse(text);

                        if (json.event?.audioOutput) {
                            if (ws.readyState === WebSocket.OPEN) {
                                ws.send(JSON.stringify({ type: "audio", data: json.event.audioOutput.content }));
                            }
                        } else if (json.event?.textOutput) {
                            if (ws.readyState === WebSocket.OPEN) {
                                ws.send(JSON.stringify({ type: "text", role: json.event.textOutput.role, content: json.event.textOutput.content }));
                            }
                        } else if (json.event?.toolUse) {
                            const toolName = json.event.toolUse.toolName;
                            const toolUseId = json.event.toolUse.toolUseId;
                            const toolContent = json.event.toolUse.content;
                            console.log(`Tool use requested: ${toolName}`, toolContent);

                            if (ws.readyState === WebSocket.OPEN) {
                                ws.send(JSON.stringify({ type: "tool_use", toolName, content: toolContent }));
                            }

                            // Keepalive pings while tool executes
                            const keepalive = setInterval(() => {
                                if (ws.readyState === WebSocket.OPEN) {
                                    ws.send(JSON.stringify({ type: "tool_working" }));
                                }
                            }, 3000);

                            try {
                                const { clientMessage, toolResponse } = await handleToolUse(toolName, toolContent, converseClient, GROUNDING_MODEL_ID);
                                if (clientMessage && ws.readyState === WebSocket.OPEN) {
                                    ws.send(JSON.stringify(clientMessage));
                                }
                                pushToolResult(toolUseId, toolResponse);
                            } catch (toolErr) {
                                console.error(`Tool error (${toolName}):`, toolErr);
                                pushToolResult(toolUseId, JSON.stringify({ error: toolErr.message }));
                            }

                            clearInterval(keepalive);
                        }
                    } catch (e) {
                        // ignore parse errors
                    }
                }
            }
        } catch (err) {
            console.error("Bedrock stream error:", err.message);
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: "error", message: err.message }));
            }
        } finally {
            isActive = false;
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: "session_end" }));
            }
        }
    }

    ws.on("message", (data) => {
        try {
            const msg = JSON.parse(data);
            if (msg.type === "start") {
                startSession();
            } else if (msg.type === "audio" && isActive) {
                pushInput(makeEvent({
                    audioInput: { promptName, contentName: audioContentName, content: msg.data },
                }));
            } else if (msg.type === "stop") {
                isActive = false;
                pushInput(null);
            }
        } catch (e) {
            console.error("Message parse error:", e);
        }
    });

    ws.on("close", () => {
        console.log("Client disconnected");
        activeClients.delete(ws);
        isActive = false;
        pushInput(null);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Nova Sonic web app running at http://localhost:${PORT}`);
});
