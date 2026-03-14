require("dotenv").config();
const express = require("express");
const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");
const path = require("path");
const {
    BedrockRuntimeClient,
    InvokeModelWithBidirectionalStreamCommand,
    ConverseCommand,
} = require("@aws-sdk/client-bedrock-runtime");
const { NodeHttp2Handler } = require("@smithy/node-http-handler");
const { fromIni } = require("@aws-sdk/credential-provider-ini");
const crypto = require("crypto");
const https = require("https");
const fs = require("fs");
const { google } = require("googleapis");

// iwejofe
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, "public")));

const REGION = process.env.AWS_REGION || "us-east-1";
const MODEL_ID = "amazon.nova-sonic-v1:0";
const GROUNDING_MODEL_ID = process.env.GROUNDING_MODEL_ID || "us.amazon.nova-premier-v1:0";
const AWS_PROFILE = process.env.AWS_PROFILE || "uoc";
const VOICE_ID = process.env.VOICE_ID || "tiffany";

// Tool definition that Nova Sonic will use to request web lookups
const WEB_SEARCH_TOOL = {
    toolSpec: {
        name: "web_search",
        description:
            "Search the web for current, real-time information. Use this tool when the user asks about recent events, news, weather, stock prices, sports scores, or any topic that requires up-to-date information beyond your training data.",
        inputSchema: {
            json: JSON.stringify({
                type: "object",
                properties: {
                    query: {
                        type: "string",
                        description: "The search query to look up on the web",
                    },
                },
                required: ["query"],
            }),
        },
    },
};

// Tool definition for scheduling Zoom meetings
const ZOOM_MEETING_TOOL = {
    toolSpec: {
        name: "schedule_zoom_meeting",
        description:
            "Schedule a Zoom meeting. Use this tool when the user asks to create, schedule, or set up a Zoom meeting or video call.",
        inputSchema: {
            json: JSON.stringify({
                type: "object",
                properties: {
                    topic: {
                        type: "string",
                        description: "The meeting topic or title",
                    },
                    duration: {
                        type: "number",
                        description: "Meeting duration in minutes. Defaults to 30.",
                    },
                    start_time: {
                        type: "string",
                        description:
                            "Meeting start time in ISO 8601 format with MST offset (e.g. 2025-03-15T14:00:00-07:00). If not provided, creates an instant meeting.",
                    },
                },
                required: ["topic"],
            }),
        },
    },
};

// Tool definition for listing upcoming Zoom meetings
const ZOOM_LIST_MEETINGS_TOOL = {
    toolSpec: {
        name: "list_zoom_meetings",
        description:
            "List upcoming scheduled Zoom meetings. Use this tool when the user asks to see their meetings, check their schedule, or asks 'what meetings do I have'.",
        inputSchema: {
            json: JSON.stringify({
                type: "object",
                properties: {},
                required: [],
            }),
        },
    },
};

// Tool definition for creating an instant Zoom meeting and auto-joining
const ZOOM_INSTANT_MEETING_TOOL = {
    toolSpec: {
        name: "instant_zoom_meeting",
        description:
            "Create an instant Zoom meeting and join it immediately. Use this tool when the user says things like 'start a Zoom call', 'create an instant meeting', 'let's hop on a call', 'start a zoom meeting', or 'join a Zoom now'.",
        inputSchema: {
            json: JSON.stringify({
                type: "object",
                properties: {
                    topic: {
                        type: "string",
                        description: "Optional meeting topic. Defaults to 'Instant Meeting'.",
                    },
                },
                required: [],
            }),
        },
    },
};

// Tool definition for creating a Google Meet meeting via Google Calendar
const GOOGLE_MEET_TOOL = {
    toolSpec: {
        name: "create_google_meet",
        description:
            "Create a Google Meet meeting by adding a calendar event with a Google Meet link. Use this when the user asks to create a Google Meet, schedule a Google Meet, or start a Google Meet call.",
        inputSchema: {
            json: JSON.stringify({
                type: "object",
                properties: {
                    topic: {
                        type: "string",
                        description: "The meeting topic or title.",
                    },
                    start_time: {
                        type: "string",
                        description: "Meeting start time in ISO 8601 format with MST offset (e.g. 2025-03-15T14:00:00-07:00). If not provided, starts in 5 minutes.",
                    },
                    duration: {
                        type: "number",
                        description: "Meeting duration in minutes. Defaults to 30.",
                    },
                    attendees: {
                        type: "string",
                        description: "Comma-separated email addresses of attendees to invite. Optional.",
                    },
                },
                required: ["topic"],
            }),
        },
    },
};

// Tool definition for fetching and summarizing a meeting transcript
const SUMMARIZE_MEETING_TOOL = {
    toolSpec: {
        name: "summarize_meeting",
        description:
            "Fetch the latest Google Meet transcript from Google Drive, summarize it, and optionally post the summary to Slack. Use this when the user says things like 'summarize my last meeting', 'get my meeting notes', or 'send meeting summary to Slack'.",
        inputSchema: {
            json: JSON.stringify({
                type: "object",
                properties: {
                    post_to_slack: {
                        type: "boolean",
                        description: "Whether to also post the summary to Slack. Defaults to false.",
                    },
                },
                required: [],
            }),
        },
    },
};

// ── Web Grounding with LRU cache ──

const groundingCache = new Map();
const CACHE_MAX = 50;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getCachedGrounding(query) {
    const key = query.toLowerCase().trim();
    const entry = groundingCache.get(key);
    if (entry && Date.now() - entry.ts < CACHE_TTL_MS) {
        return entry.data;
    }
    if (entry) groundingCache.delete(key);
    return null;
}

function setCachedGrounding(query, data) {
    const key = query.toLowerCase().trim();
    if (groundingCache.size >= CACHE_MAX) {
        const oldest = groundingCache.keys().next().value;
        groundingCache.delete(oldest);
    }
    groundingCache.set(key, { data, ts: Date.now() });
}

async function performWebGrounding(query, bedrockClient) {
    const cached = getCachedGrounding(query);
    if (cached) {
        console.log(`Grounding cache hit for "${query}"`);
        return cached;
    }

    try {
        const command = new ConverseCommand({
            modelId: GROUNDING_MODEL_ID,
            messages: [
                {
                    role: "user",
                    content: [{ text: query }],
                },
            ],
            toolConfig: {
                tools: [
                    {
                        systemTool: {
                            name: "nova_grounding",
                        },
                    },
                ],
            },
        });

        const response = await bedrockClient.send(command);
        const contentList = response.output?.message?.content || [];

        let text = "";
        const citations = [];

        for (const block of contentList) {
            if (block.text) {
                text += block.text;
            }
            if (block.citationsContent?.citations) {
                for (const citation of block.citationsContent.citations) {
                    if (citation.location?.web) {
                        citations.push({
                            url: citation.location.web.url,
                            domain: citation.location.web.domain || "",
                        });
                    }
                }
            }
        }

        const result = {
            query,
            summary: (text || "No results found.").substring(0, 2000),
            citations,
        };

        setCachedGrounding(query, result);
        return result;
    } catch (err) {
        console.error("Web grounding error:", err.message);
        return {
            query,
            summary: `Web grounding search failed: ${err.message}`,
            citations: [],
        };
    }
}

// ── Zoom API Integration ──
// Requires env vars: ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET

let zoomAccessToken = null;
let zoomTokenExpiry = 0;

function getZoomAccessToken() {
    return new Promise((resolve, reject) => {
        const accountId = process.env.ZOOM_ACCOUNT_ID;
        const clientId = process.env.ZOOM_CLIENT_ID;
        const clientSecret = process.env.ZOOM_CLIENT_SECRET;

        if (!accountId || !clientId || !clientSecret) {
            return reject(new Error("Zoom credentials not configured. Set ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, and ZOOM_CLIENT_SECRET env vars."));
        }

        // Return cached token if still valid
        if (zoomAccessToken && Date.now() < zoomTokenExpiry - 60000) {
            return resolve(zoomAccessToken);
        }

        const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
        const postData = `grant_type=account_credentials&account_id=${accountId}`;

        const req = https.request(
            {
                hostname: "zoom.us",
                path: "/oauth/token",
                method: "POST",
                headers: {
                    Authorization: `Basic ${auth}`,
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Content-Length": Buffer.byteLength(postData),
                },
            },
            (res) => {
                let data = "";
                res.on("data", (chunk) => (data += chunk));
                res.on("end", () => {
                    try {
                        const json = JSON.parse(data);
                        if (json.access_token) {
                            zoomAccessToken = json.access_token;
                            zoomTokenExpiry = Date.now() + json.expires_in * 1000;
                            resolve(zoomAccessToken);
                        } else {
                            reject(new Error(json.reason || "Failed to get Zoom token"));
                        }
                    } catch (e) {
                        reject(new Error("Failed to parse Zoom token response"));
                    }
                });
            }
        );
        req.on("error", reject);
        req.write(postData);
        req.end();
    });
}

async function createZoomMeeting({ topic, duration, start_time }) {
    const token = await getZoomAccessToken();

    const meetingData = {
        topic: topic || "Scheduled Meeting",
        type: start_time ? 2 : 1, // 2 = scheduled, 1 = instant
        duration: duration || 30,
        timezone: "America/Arizona",
        settings: {
            join_before_host: true,
            waiting_room: false,
            auto_recording: "none",
        },
    };

    if (start_time) {
        meetingData.start_time = start_time;
    }

    const body = JSON.stringify(meetingData);

    return new Promise((resolve, reject) => {
        const req = https.request(
            {
                hostname: "api.zoom.us",
                path: "/v2/users/me/meetings",
                method: "POST",
                headers: {
                    Authorization: `Bearer ${token}`,
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(body),
                },
            },
            (res) => {
                let data = "";
                res.on("data", (chunk) => (data += chunk));
                res.on("end", () => {
                    try {
                        const json = JSON.parse(data);
                        if (json.join_url) {
                            resolve({
                                success: true,
                                topic: json.topic,
                                join_url: json.join_url,
                                meeting_id: json.id,
                                passcode: json.password || "",
                                start_time: json.start_time || "now",
                                duration: json.duration,
                            });
                        } else {
                            resolve({
                                success: false,
                                error: json.message || "Failed to create meeting",
                            });
                        }
                    } catch (e) {
                        resolve({ success: false, error: "Failed to parse Zoom response" });
                    }
                });
            }
        );
        req.on("error", (err) => resolve({ success: false, error: err.message }));
        req.write(body);
        req.end();
    });
}

async function listZoomMeetings() {
    const token = await getZoomAccessToken();

    return new Promise((resolve, reject) => {
        const req = https.request(
            {
                hostname: "api.zoom.us",
                path: "/v2/users/me/meetings?type=upcoming&page_size=10",
                method: "GET",
                headers: {
                    Authorization: `Bearer ${token}`,
                    "Content-Type": "application/json",
                },
            },
            (res) => {
                let data = "";
                res.on("data", (chunk) => (data += chunk));
                res.on("end", () => {
                    try {
                        const json = JSON.parse(data);
                        const meetings = (json.meetings || []).map((m) => ({
                            id: m.id,
                            topic: m.topic,
                            start_time: m.start_time || "instant",
                            duration: m.duration,
                            join_url: m.join_url,
                        }));
                        resolve({ success: true, meetings, total: json.total_records || meetings.length });
                    } catch (e) {
                        resolve({ success: false, error: "Failed to parse Zoom response", meetings: [] });
                    }
                });
            }
        );
        req.on("error", (err) => resolve({ success: false, error: err.message, meetings: [] }));
        req.end();
    });
}

// ── Google Drive Integration ──

function getGoogleAuth() {
    const credPath = path.join(__dirname, "credentials.json");
    const tokenPath = path.join(__dirname, "google-token.json");

    if (!fs.existsSync(credPath) || !fs.existsSync(tokenPath)) {
        throw new Error("Google credentials not configured. Run: node google-auth.js");
    }

    const creds = JSON.parse(fs.readFileSync(credPath, "utf-8"));
    const { client_id, client_secret } = creds.installed || creds.web;
    const oauth2Client = new google.auth.OAuth2(client_id, client_secret);
    const tokens = JSON.parse(fs.readFileSync(tokenPath, "utf-8"));
    oauth2Client.setCredentials(tokens);

    // Auto-refresh token
    oauth2Client.on("tokens", (newTokens) => {
        const merged = { ...tokens, ...newTokens };
        fs.writeFileSync(tokenPath, JSON.stringify(merged, null, 2));
    });

    return oauth2Client;
}

async function fetchLatestMeetTranscript() {
    const auth = getGoogleAuth();
    const drive = google.drive({ version: "v3", auth });

    // Search for Meet transcript docs
    const res = await drive.files.list({
        q: "name contains 'transcript' and mimeType = 'application/vnd.google-apps.document'",
        orderBy: "modifiedTime desc",
        pageSize: 5,
        fields: "files(id, name, modifiedTime)",
    });

    const files = res.data.files || [];
    if (files.length === 0) {
        return { success: false, error: "No meeting transcript is available yet. Google Meet can take a few minutes to upload the transcript to Drive after the meeting ends. Please try again in a few minutes." };
    }

    const latest = files[0];

    // Export as plain text
    const content = await drive.files.export({
        fileId: latest.id,
        mimeType: "text/plain",
    });

    return {
        success: true,
        fileName: latest.name,
        modifiedTime: latest.modifiedTime,
        transcript: content.data.substring(0, 15000), // cap at 15k chars
    };
}

// ── Google Meet (via Calendar) ──

async function createGoogleMeet({ topic, start_time, duration, attendees }) {
    const auth = getGoogleAuth();
    const calendar = google.calendar({ version: "v3", auth });

    const durationMin = duration || 30;
    const start = start_time ? new Date(start_time) : new Date(Date.now() + 5 * 60 * 1000);
    const end = new Date(start.getTime() + durationMin * 60 * 1000);

    const event = {
        summary: topic || "Google Meet Meeting",
        start: { dateTime: start.toISOString(), timeZone: "America/Denver" },
        end: { dateTime: end.toISOString(), timeZone: "America/Denver" },
        conferenceData: {
            createRequest: {
                requestId: crypto.randomUUID(),
                conferenceSolutionKey: { type: "hangoutsMeet" },
            },
        },
    };

    if (attendees) {
        event.attendees = attendees.split(",").map((e) => ({ email: e.trim() }));
    }

    try {
        const res = await calendar.events.insert({
            calendarId: "primary",
            resource: event,
            conferenceDataVersion: 1,
            sendUpdates: attendees ? "all" : "none",
        });

        const meetLink = res.data.hangoutLink || res.data.conferenceData?.entryPoints?.[0]?.uri;

        return {
            success: true,
            topic: res.data.summary,
            meet_link: meetLink || "",
            start_time: res.data.start.dateTime,
            duration: durationMin,
            event_id: res.data.id,
        };
    } catch (err) {
        console.error("Google Meet creation error:", err.message);
        return { success: false, error: err.message };
    }
}

// ── Meeting Summarization ──

async function summarizeMeetingTranscript(transcript, bedrockClient) {
    const command = new ConverseCommand({
        modelId: GROUNDING_MODEL_ID,
        messages: [
            {
                role: "user",
                content: [
                    {
                        text: `Summarize the following meeting transcript into a structured report with these sections:
- **Meeting Summary**: 2-3 sentence overview
- **Key Discussion Points**: bullet points of main topics
- **Action Items**: specific tasks and owners if mentioned
- **Decisions Made**: any decisions reached

Transcript:
${transcript}`,
                    },
                ],
            },
        ],
    });

    const response = await bedrockClient.send(command);
    const contentList = response.output?.message?.content || [];
    let summary = "";
    for (const block of contentList) {
        if (block.text) summary += block.text;
    }
    return summary || "Failed to generate summary.";
}

// ── Slack Integration ──

function postToSlack(message) {
    const webhookUrl = process.env.SLACK_WEBHOOK_URL;
    if (!webhookUrl || webhookUrl === "your-slack-webhook-url-here") {
        return Promise.resolve({ success: false, error: "Slack webhook not configured." });
    }

    const url = new URL(webhookUrl);
    const body = JSON.stringify({ text: message });

    return new Promise((resolve) => {
        const req = https.request(
            {
                hostname: url.hostname,
                path: url.pathname,
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(body),
                },
            },
            (res) => {
                let data = "";
                res.on("data", (chunk) => (data += chunk));
                res.on("end", () => {
                    resolve({ success: res.statusCode === 200, response: data });
                });
            }
        );
        req.on("error", (err) => resolve({ success: false, error: err.message }));
        req.write(body);
        req.end();
    });
}

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

// Separate client for Converse API calls (nova_grounding) — shared singleton
const converseClient = new BedrockRuntimeClient({
    region: REGION,
    credentials: fromIni({ profile: AWS_PROFILE }),
});

function randomId() {
    return crypto.randomUUID();
}

// Strip URLs and passcodes so Nova Sonic doesn't read them aloud
function sanitizeMeetingResult(result) {
    const { join_url, passcode, meeting_id, ...safe } = result;
    return safe;
}

wss.on("connection", (ws) => {
    console.log("Client connected");

    let bedrockClient = createBedrockClient();
    let isActive = false;
    let promptName = randomId();
    let contentName = randomId();
    let audioContentName = randomId();
    let inputResolve = null;
    let inputQueue = [];

    // Generator that yields events to Bedrock
    async function* generateEvents() {
        // 1. Session start
        yield {
            chunk: {
                bytes: Buffer.from(
                    JSON.stringify({
                        event: {
                            sessionStart: {
                                inferenceConfiguration: {
                                    maxTokens: 1024,
                                    topP: 0.9,
                                    temperature: 0.7,
                                },
                            },
                        },
                    })
                ),
            },
        };
        await sleep(50);

        // 2. Prompt start
        yield {
            chunk: {
                bytes: Buffer.from(
                    JSON.stringify({
                        event: {
                            promptStart: {
                                promptName,
                                textOutputConfiguration: { mediaType: "text/plain" },
                                audioOutputConfiguration: {
                                    mediaType: "audio/lpcm",
                                    sampleRateHertz: 24000,
                                    sampleSizeBits: 16,
                                    channelCount: 1,
                                    voiceId: VOICE_ID,
                                    encoding: "base64",
                                    audioType: "SPEECH",
                                },
                                toolUseOutputConfiguration: {
                                    mediaType: "application/json",
                                },
                                toolConfiguration: {
                                    tools: [WEB_SEARCH_TOOL, ZOOM_MEETING_TOOL, ZOOM_INSTANT_MEETING_TOOL, ZOOM_LIST_MEETINGS_TOOL, GOOGLE_MEET_TOOL, SUMMARIZE_MEETING_TOOL],
                                    toolChoice: { auto: {} },
                                },
                            },
                        },
                    })
                ),
            },
        };
        await sleep(50);

        // 3. System prompt
        yield {
            chunk: {
                bytes: Buffer.from(
                    JSON.stringify({
                        event: {
                            contentStart: {
                                promptName,
                                contentName,
                                type: "TEXT",
                                interactive: true,
                                role: "SYSTEM",
                                textInputConfiguration: { mediaType: "text/plain" },
                            },
                        },
                    })
                ),
            },
        };
        await sleep(30);

        yield {
            chunk: {
                bytes: Buffer.from(
                    JSON.stringify({
                        event: {
                            textInput: {
                                promptName,
                                contentName,
                                content:
                                    `You are a friendly assistant with web search, Zoom meeting, Google Meet, and meeting summary capabilities. Today's date is ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "America/Denver" })}. The user and you will engage in a spoken dialog exchanging the transcripts of a natural real-time conversation. Keep your responses short, generally two or three sentences for chatty scenarios. When the user asks about current events, news, weather, real-time information, or anything you're unsure about, use the web_search tool to look it up. Always mention your sources briefly when using search results. When the user asks to schedule or create a Zoom meeting, use the schedule_zoom_meeting tool. Always assume the user's timezone is MST (Mountain Standard Time, UTC-7) and convert times to ISO 8601 with the MST offset. Always use the current year when scheduling meetings. When the user wants to start an instant call or join a Zoom right now, use the instant_zoom_meeting tool. When the user asks to see or list their meetings, use the list_zoom_meetings tool. When the user asks to create or schedule a Google Meet, use the create_google_meet tool. When the user asks to summarize a meeting, get meeting notes, or send a meeting summary to Slack, use the summarize_meeting tool. Ask if they want it posted to Slack. Do not read out meeting links or IDs. Ask for a topic if the user doesn't provide one.`,
                            },
                        },
                    })
                ),
            },
        };
        await sleep(30);

        yield {
            chunk: {
                bytes: Buffer.from(
                    JSON.stringify({
                        event: {
                            contentEnd: { promptName, contentName },
                        },
                    })
                ),
            },
        };
        await sleep(30);

        // 4. Audio content start
        yield {
            chunk: {
                bytes: Buffer.from(
                    JSON.stringify({
                        event: {
                            contentStart: {
                                promptName,
                                contentName: audioContentName,
                                type: "AUDIO",
                                interactive: true,
                                role: "USER",
                                audioInputConfiguration: {
                                    mediaType: "audio/lpcm",
                                    sampleRateHertz: 16000,
                                    sampleSizeBits: 16,
                                    channelCount: 1,
                                    audioType: "SPEECH",
                                    encoding: "base64",
                                },
                            },
                        },
                    })
                ),
            },
        };
        await sleep(30);

        // 5. Stream audio chunks from the client
        while (isActive) {
            const event = await getNextInput();
            if (event === null) break;
            yield event;
        }

        // 6. Audio content end
        yield {
            chunk: {
                bytes: Buffer.from(
                    JSON.stringify({
                        event: {
                            contentEnd: { promptName, contentName: audioContentName },
                        },
                    })
                ),
            },
        };
        await sleep(30);

        // 7. Prompt end
        yield {
            chunk: {
                bytes: Buffer.from(
                    JSON.stringify({
                        event: {
                            promptEnd: { promptName },
                        },
                    })
                ),
            },
        };
        await sleep(30);

        // 8. Session end
        yield {
            chunk: {
                bytes: Buffer.from(
                    JSON.stringify({
                        event: {
                            sessionEnd: {},
                        },
                    })
                ),
            },
        };
    }

    function getNextInput() {
        return new Promise((resolve) => {
            if (inputQueue.length > 0) {
                resolve(inputQueue.shift());
            } else {
                inputResolve = resolve;
            }
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

    function sleep(ms) {
        return new Promise((r) => setTimeout(r, ms));
    }

    async function startSession() {
        isActive = true;

        try {
            const command = new InvokeModelWithBidirectionalStreamCommand({
                modelId: MODEL_ID,
                body: generateEvents(),
            });

            const response = await bedrockClient.send(command);

            // Process output events
            for await (const event of response.body) {
                if (!isActive) break;

                if (event.chunk?.bytes) {
                    try {
                        const text = new TextDecoder().decode(event.chunk.bytes);
                        const json = JSON.parse(text);

                        if (json.event?.audioOutput) {
                            // Send audio back to client
                            if (ws.readyState === WebSocket.OPEN) {
                                ws.send(
                                    JSON.stringify({
                                        type: "audio",
                                        data: json.event.audioOutput.content,
                                    })
                                );
                            }
                        } else if (json.event?.textOutput) {
                            const role = json.event.textOutput.role;
                            const content = json.event.textOutput.content;
                            if (ws.readyState === WebSocket.OPEN) {
                                ws.send(JSON.stringify({ type: "text", role, content }));
                            }
                        } else if (json.event?.toolUse) {
                            // Model wants to use a tool
                            const toolName = json.event.toolUse.toolName;
                            const toolUseId = json.event.toolUse.toolUseId;
                            const toolContent = json.event.toolUse.content;
                            console.log(`Tool use requested: ${toolName}`, toolContent);

                            if (ws.readyState === WebSocket.OPEN) {
                                ws.send(
                                    JSON.stringify({
                                        type: "tool_use",
                                        toolName,
                                        content: toolContent,
                                    })
                                );
                            }

                            if (toolName === "web_search") {
                                try {
                                    const params = JSON.parse(toolContent);
                                    const groundingResult = await performWebGrounding(params.query, converseClient);
                                    console.log(`Grounding results for "${params.query}":`, groundingResult.citations.length, "citations");

                                    // Send grounding results to client for display
                                    if (ws.readyState === WebSocket.OPEN) {
                                        ws.send(
                                            JSON.stringify({
                                                type: "search_results",
                                                query: params.query,
                                                summary: groundingResult.summary,
                                                citations: groundingResult.citations,
                                            })
                                        );
                                    }

                                    // Send tool result back to Nova Sonic
                                    const toolResultContentName = randomId();

                                    // contentStart for tool result
                                    pushInput({
                                        chunk: {
                                            bytes: Buffer.from(
                                                JSON.stringify({
                                                    event: {
                                                        contentStart: {
                                                            promptName,
                                                            contentName: toolResultContentName,
                                                            interactive: false,
                                                            type: "TOOL",
                                                            role: "TOOL",
                                                            toolResultInputConfiguration: {
                                                                toolUseId,
                                                                type: "TEXT",
                                                                textInputConfiguration: {
                                                                    mediaType: "text/plain",
                                                                },
                                                            },
                                                        },
                                                    },
                                                })
                                            ),
                                        },
                                    });

                                    // tool result content
                                    pushInput({
                                        chunk: {
                                            bytes: Buffer.from(
                                                JSON.stringify({
                                                    event: {
                                                        toolResult: {
                                                            promptName,
                                                            contentName: toolResultContentName,
                                                            content: JSON.stringify(groundingResult),
                                                        },
                                                    },
                                                })
                                            ),
                                        },
                                    });

                                    // contentEnd for tool result
                                    pushInput({
                                        chunk: {
                                            bytes: Buffer.from(
                                                JSON.stringify({
                                                    event: {
                                                        contentEnd: {
                                                            promptName,
                                                            contentName: toolResultContentName,
                                                        },
                                                    },
                                                })
                                            ),
                                        },
                                    });
                                } catch (toolErr) {
                                    console.error("Tool execution error:", toolErr);
                                }
                            } else if (toolName === "schedule_zoom_meeting") {
                                try {
                                    const params = JSON.parse(toolContent);
                                    console.log("Creating Zoom meeting:", params);

                                    const meetingResult = await createZoomMeeting(params);
                                    console.log("Zoom meeting result:", meetingResult);

                                    // Send meeting info to client for display
                                    if (ws.readyState === WebSocket.OPEN) {
                                        ws.send(
                                            JSON.stringify({
                                                type: "zoom_meeting",
                                                ...meetingResult,
                                            })
                                        );
                                    }

                                    // Send tool result back to Nova Sonic (sanitized)
                                    const toolResultContentName = randomId();
                                    const safeResult = sanitizeMeetingResult(meetingResult);

                                    pushInput({
                                        chunk: {
                                            bytes: Buffer.from(
                                                JSON.stringify({
                                                    event: {
                                                        contentStart: {
                                                            promptName,
                                                            contentName: toolResultContentName,
                                                            interactive: false,
                                                            type: "TOOL",
                                                            role: "TOOL",
                                                            toolResultInputConfiguration: {
                                                                toolUseId,
                                                                type: "TEXT",
                                                                textInputConfiguration: {
                                                                    mediaType: "text/plain",
                                                                },
                                                            },
                                                        },
                                                    },
                                                })
                                            ),
                                        },
                                    });

                                    pushInput({
                                        chunk: {
                                            bytes: Buffer.from(
                                                JSON.stringify({
                                                    event: {
                                                        toolResult: {
                                                            promptName,
                                                            contentName: toolResultContentName,
                                                            content: JSON.stringify(safeResult),
                                                        },
                                                    },
                                                })
                                            ),
                                        },
                                    });

                                    pushInput({
                                        chunk: {
                                            bytes: Buffer.from(
                                                JSON.stringify({
                                                    event: {
                                                        contentEnd: {
                                                            promptName,
                                                            contentName: toolResultContentName,
                                                        },
                                                    },
                                                })
                                            ),
                                        },
                                    });
                                } catch (toolErr) {
                                    console.error("Zoom tool error:", toolErr);
                                }
                            } else if (toolName === "instant_zoom_meeting") {
                                try {
                                    const params = JSON.parse(toolContent);
                                    console.log("Creating instant Zoom meeting:", params);

                                    const meetingResult = await createZoomMeeting({
                                        topic: params.topic || "Instant Meeting",
                                    });
                                    console.log("Instant Zoom meeting result:", meetingResult);

                                    // Send with auto_join flag so the client opens it
                                    if (ws.readyState === WebSocket.OPEN) {
                                        ws.send(
                                            JSON.stringify({
                                                type: "zoom_meeting",
                                                auto_join: true,
                                                ...meetingResult,
                                            })
                                        );
                                    }

                                    const toolResultContentName = randomId();
                                    const safeResult = sanitizeMeetingResult(meetingResult);

                                    pushInput({
                                        chunk: {
                                            bytes: Buffer.from(
                                                JSON.stringify({
                                                    event: {
                                                        contentStart: {
                                                            promptName,
                                                            contentName: toolResultContentName,
                                                            interactive: false,
                                                            type: "TOOL",
                                                            role: "TOOL",
                                                            toolResultInputConfiguration: {
                                                                toolUseId,
                                                                type: "TEXT",
                                                                textInputConfiguration: {
                                                                    mediaType: "text/plain",
                                                                },
                                                            },
                                                        },
                                                    },
                                                })
                                            ),
                                        },
                                    });

                                    pushInput({
                                        chunk: {
                                            bytes: Buffer.from(
                                                JSON.stringify({
                                                    event: {
                                                        toolResult: {
                                                            promptName,
                                                            contentName: toolResultContentName,
                                                            content: JSON.stringify(safeResult),
                                                        },
                                                    },
                                                })
                                            ),
                                        },
                                    });

                                    pushInput({
                                        chunk: {
                                            bytes: Buffer.from(
                                                JSON.stringify({
                                                    event: {
                                                        contentEnd: {
                                                            promptName,
                                                            contentName: toolResultContentName,
                                                        },
                                                    },
                                                })
                                            ),
                                        },
                                    });
                                } catch (toolErr) {
                                    console.error("Instant Zoom tool error:", toolErr);
                                }
                            } else if (toolName === "list_zoom_meetings") {
                                try {
                                    console.log("Listing Zoom meetings");
                                    const listResult = await listZoomMeetings();
                                    console.log("Zoom meetings list:", listResult.total, "meetings");

                                    if (ws.readyState === WebSocket.OPEN) {
                                        ws.send(
                                            JSON.stringify({
                                                type: "zoom_meetings_list",
                                                ...listResult,
                                            })
                                        );
                                    }

                                    const toolResultContentName = randomId();

                                    pushInput({
                                        chunk: {
                                            bytes: Buffer.from(
                                                JSON.stringify({
                                                    event: {
                                                        contentStart: {
                                                            promptName,
                                                            contentName: toolResultContentName,
                                                            interactive: false,
                                                            type: "TOOL",
                                                            role: "TOOL",
                                                            toolResultInputConfiguration: {
                                                                toolUseId,
                                                                type: "TEXT",
                                                                textInputConfiguration: {
                                                                    mediaType: "text/plain",
                                                                },
                                                            },
                                                        },
                                                    },
                                                })
                                            ),
                                        },
                                    });

                                    pushInput({
                                        chunk: {
                                            bytes: Buffer.from(
                                                JSON.stringify({
                                                    event: {
                                                        toolResult: {
                                                            promptName,
                                                            contentName: toolResultContentName,
                                                            content: JSON.stringify({
                                                                success: listResult.success,
                                                                total: listResult.total,
                                                                meetings: (listResult.meetings || []).map(m => ({
                                                                    topic: m.topic,
                                                                    start_time: m.start_time,
                                                                    duration: m.duration,
                                                                })),
                                                            }),
                                                        },
                                                    },
                                                })
                                            ),
                                        },
                                    });

                                    pushInput({
                                        chunk: {
                                            bytes: Buffer.from(
                                                JSON.stringify({
                                                    event: {
                                                        contentEnd: {
                                                            promptName,
                                                            contentName: toolResultContentName,
                                                        },
                                                    },
                                                })
                                            ),
                                        },
                                    });
                                } catch (toolErr) {
                                    console.error("List Zoom meetings error:", toolErr);
                                }
                            } else if (toolName === "summarize_meeting") {
                                try {
                                    const params = JSON.parse(toolContent);
                                    console.log("Summarizing meeting, post_to_slack:", params.post_to_slack);

                                    if (ws.readyState === WebSocket.OPEN) {
                                        ws.send(JSON.stringify({ type: "tool_use", toolName: "summarize_meeting", content: toolContent }));
                                    }

                                    // 1. Fetch transcript from Google Drive
                                    const transcriptResult = await fetchLatestMeetTranscript();
                                    let toolResponse;

                                    if (!transcriptResult.success) {
                                        toolResponse = { success: false, error: transcriptResult.error };
                                    } else {
                                        // 2. Summarize with Nova
                                        const summary = await summarizeMeetingTranscript(transcriptResult.transcript, converseClient);

                                        toolResponse = {
                                            success: true,
                                            fileName: transcriptResult.fileName,
                                            summary,
                                        };

                                        // 3. Post to Slack if requested
                                        if (params.post_to_slack) {
                                            const slackMessage = `📋 *Meeting Summary*\n_${transcriptResult.fileName}_\n\n${summary}`;
                                            const slackResult = await postToSlack(slackMessage);
                                            toolResponse.slack_posted = slackResult.success;
                                            if (!slackResult.success) {
                                                toolResponse.slack_error = slackResult.error;
                                            }
                                        }

                                        // Send summary to client for display
                                        if (ws.readyState === WebSocket.OPEN) {
                                            ws.send(JSON.stringify({
                                                type: "meeting_summary",
                                                fileName: transcriptResult.fileName,
                                                summary,
                                                slack_posted: toolResponse.slack_posted || false,
                                            }));
                                        }
                                    }

                                    const toolResultContentName = randomId();

                                    pushInput({
                                        chunk: {
                                            bytes: Buffer.from(
                                                JSON.stringify({
                                                    event: {
                                                        contentStart: {
                                                            promptName,
                                                            contentName: toolResultContentName,
                                                            interactive: false,
                                                            type: "TOOL",
                                                            role: "TOOL",
                                                            toolResultInputConfiguration: {
                                                                toolUseId,
                                                                type: "TEXT",
                                                                textInputConfiguration: {
                                                                    mediaType: "text/plain",
                                                                },
                                                            },
                                                        },
                                                    },
                                                })
                                            ),
                                        },
                                    });

                                    // Send sanitized result (no full transcript)
                                    const safeToolResponse = {
                                        success: toolResponse.success,
                                        fileName: toolResponse.fileName,
                                        summary_preview: toolResponse.summary ? toolResponse.summary.substring(0, 500) : undefined,
                                        slack_posted: toolResponse.slack_posted,
                                        error: toolResponse.error,
                                    };

                                    pushInput({
                                        chunk: {
                                            bytes: Buffer.from(
                                                JSON.stringify({
                                                    event: {
                                                        toolResult: {
                                                            promptName,
                                                            contentName: toolResultContentName,
                                                            content: JSON.stringify(safeToolResponse),
                                                        },
                                                    },
                                                })
                                            ),
                                        },
                                    });

                                    pushInput({
                                        chunk: {
                                            bytes: Buffer.from(
                                                JSON.stringify({
                                                    event: {
                                                        contentEnd: {
                                                            promptName,
                                                            contentName: toolResultContentName,
                                                        },
                                                    },
                                                })
                                            ),
                                        },
                                    });
                                } catch (toolErr) {
                                    console.error("Summarize meeting error:", toolErr);
                                }
                            } else if (toolName === "create_google_meet") {
                                try {
                                    const params = JSON.parse(toolContent);
                                    console.log("Creating Google Meet:", params);

                                    const meetResult = await createGoogleMeet(params);
                                    console.log("Google Meet result:", meetResult);

                                    // Send full result to client for display
                                    if (ws.readyState === WebSocket.OPEN) {
                                        ws.send(JSON.stringify({
                                            type: "google_meet",
                                            ...meetResult,
                                        }));
                                    }

                                    const toolResultContentName = randomId();

                                    // Sanitize — don't send link/ID to model
                                    const safeResult = {
                                        success: meetResult.success,
                                        topic: meetResult.topic,
                                        start_time: meetResult.start_time,
                                        duration: meetResult.duration,
                                        error: meetResult.error,
                                    };

                                    pushInput({
                                        chunk: {
                                            bytes: Buffer.from(
                                                JSON.stringify({
                                                    event: {
                                                        contentStart: {
                                                            promptName,
                                                            contentName: toolResultContentName,
                                                            interactive: false,
                                                            type: "TOOL",
                                                            role: "TOOL",
                                                            toolResultInputConfiguration: {
                                                                toolUseId,
                                                                type: "TEXT",
                                                                textInputConfiguration: {
                                                                    mediaType: "text/plain",
                                                                },
                                                            },
                                                        },
                                                    },
                                                })
                                            ),
                                        },
                                    });

                                    pushInput({
                                        chunk: {
                                            bytes: Buffer.from(
                                                JSON.stringify({
                                                    event: {
                                                        toolResult: {
                                                            promptName,
                                                            contentName: toolResultContentName,
                                                            content: JSON.stringify(safeResult),
                                                        },
                                                    },
                                                })
                                            ),
                                        },
                                    });

                                    pushInput({
                                        chunk: {
                                            bytes: Buffer.from(
                                                JSON.stringify({
                                                    event: {
                                                        contentEnd: {
                                                            promptName,
                                                            contentName: toolResultContentName,
                                                        },
                                                    },
                                                })
                                            ),
                                        },
                                    });
                                } catch (toolErr) {
                                    console.error("Google Meet creation error:", toolErr);
                                }
                            }
                        } else if (json.event?.contentStart) {
                            // Could track role changes here
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
                // Audio chunk from browser (base64 encoded PCM)
                const audioEvent = {
                    chunk: {
                        bytes: Buffer.from(
                            JSON.stringify({
                                event: {
                                    audioInput: {
                                        promptName,
                                        contentName: audioContentName,
                                        content: msg.data, // already base64
                                    },
                                },
                            })
                        ),
                    },
                };
                pushInput(audioEvent);
            } else if (msg.type === "stop") {
                isActive = false;
                pushInput(null); // signal end
            }
        } catch (e) {
            console.error("Message parse error:", e);
        }
    });

    ws.on("close", () => {
        console.log("Client disconnected");
        isActive = false;
        pushInput(null);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Nova Sonic web app running at http://localhost:${PORT}`);
});
