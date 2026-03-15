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

// ── Reminder Infrastructure ──
const REMINDERS_PATH = path.join(__dirname, "reminders.json");
const activeTimers = new Map(); // id -> timeout handle
const activeClients = new Set(); // track connected websockets

function loadReminders() {
    try {
        if (fs.existsSync(REMINDERS_PATH)) {
            return JSON.parse(fs.readFileSync(REMINDERS_PATH, "utf-8"));
        }
    } catch (e) {
        console.error("Error loading reminders:", e.message);
    }
    return [];
}

function saveReminders(reminders) {
    fs.writeFileSync(REMINDERS_PATH, JSON.stringify(reminders, null, 2));
}

function broadcastReminder(reminder) {
    const msg = JSON.stringify({
        type: "reminder",
        id: reminder.id,
        message: reminder.message,
        fireAt: reminder.fireAt,
    });
    for (const client of activeClients) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(msg);
        }
    }
}

function scheduleReminder(reminder) {
    const delay = new Date(reminder.fireAt).getTime() - Date.now();
    if (delay <= 0) {
        // Already past — deliver immediately if clients connected, then remove
        broadcastReminder(reminder);
        removeReminder(reminder.id);
        return;
    }
    const timer = setTimeout(() => {
        console.log(`🔔 Reminder fired: ${reminder.message}`);
        broadcastReminder(reminder);
        removeReminder(reminder.id);
    }, delay);
    activeTimers.set(reminder.id, timer);
}

function removeReminder(id) {
    if (activeTimers.has(id)) {
        clearTimeout(activeTimers.get(id));
        activeTimers.delete(id);
    }
    const reminders = loadReminders().filter((r) => r.id !== id);
    saveReminders(reminders);
}

function addReminder({ message, minutes, remind_at }) {
    let fireAt;
    if (remind_at) {
        fireAt = new Date(remind_at).toISOString();
    } else {
        const mins = minutes || 5;
        fireAt = new Date(Date.now() + mins * 60 * 1000).toISOString();
    }

    const reminder = {
        id: crypto.randomUUID(),
        message,
        fireAt,
        createdAt: new Date().toISOString(),
    };

    const reminders = loadReminders();
    reminders.push(reminder);
    saveReminders(reminders);
    scheduleReminder(reminder);

    return reminder;
}

// Restore reminders on server start
(function restoreReminders() {
    const reminders = loadReminders();
    const now = Date.now();
    const pending = [];
    for (const r of reminders) {
        if (new Date(r.fireAt).getTime() > now) {
            scheduleReminder(r);
            pending.push(r);
        }
    }
    // Clean up expired ones
    saveReminders(pending);
    if (pending.length > 0) {
        console.log(`Restored ${pending.length} pending reminder(s)`);
    }
})();

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

// Tool definition for listing Google Calendar events
const GOOGLE_CALENDAR_LIST_TOOL = {
    toolSpec: {
        name: "list_google_calendar_events",
        description:
            "List upcoming events from the user's Google Calendar. Use this when the user asks 'what's on my calendar', 'what meetings do I have today', 'am I free tomorrow', or 'show my schedule'.",
        inputSchema: {
            json: JSON.stringify({
                type: "object",
                properties: {
                    date: {
                        type: "string",
                        description: "Optional date to check in ISO 8601 format (e.g. 2025-07-14). If not provided, shows today's events.",
                    },
                    days: {
                        type: "number",
                        description: "Number of days to look ahead. Defaults to 1.",
                    },
                },
                required: [],
            }),
        },
    },
};

// Tool definition for adding a Google Calendar event (no Meet link)
const GOOGLE_CALENDAR_ADD_TOOL = {
    toolSpec: {
        name: "add_google_calendar_event",
        description:
            "Add a new event to the user's Google Calendar. Use this when the user asks to 'add an event', 'create a calendar event', 'block time', 'schedule something on my calendar', or 'put X on my calendar'. Do NOT use this for Google Meet meetings — use create_google_meet instead. This tool automatically checks for scheduling conflicts. If a conflict is found, tell the user about the conflicting events and ask if they want to proceed. If they confirm, call this tool again with force set to true.",
        inputSchema: {
            json: JSON.stringify({
                type: "object",
                properties: {
                    title: {
                        type: "string",
                        description: "The event title or summary.",
                    },
                    start_time: {
                        type: "string",
                        description: "Event start time in ISO 8601 format with MST offset (e.g. 2025-03-15T14:00:00-07:00).",
                    },
                    duration: {
                        type: "number",
                        description: "Event duration in minutes. Defaults to 60.",
                    },
                    description: {
                        type: "string",
                        description: "Optional event description or notes.",
                    },
                    location: {
                        type: "string",
                        description: "Optional event location.",
                    },
                    attendees: {
                        type: "string",
                        description: "Comma-separated email addresses of attendees. Optional.",
                    },
                    force: {
                        type: "boolean",
                        description: "Set to true to create the event even if there are conflicts. Only use after the user confirms.",
                    },
                },
                required: ["title", "start_time"],
            }),
        },
    },
};

// Tool definition for creating a Google Meet meeting via Google Calendar
const GOOGLE_MEET_TOOL = {
    toolSpec: {
        name: "create_google_meet",
        description:
            "Create a Google Meet meeting by adding a calendar event with a Google Meet link. Use this when the user asks to create a Google Meet, schedule a Google Meet, or start a Google Meet call. This tool automatically checks for scheduling conflicts. If a conflict is found, tell the user about the conflicting events and ask if they want to proceed. If they confirm, call this tool again with force set to true.",
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
                    force: {
                        type: "boolean",
                        description: "Set to true to create the meeting even if there are conflicts. Only use after the user confirms.",
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

// Tool definition for setting a quick reminder
const SET_REMINDER_TOOL = {
    toolSpec: {
        name: "set_reminder",
        description:
            "Set a reminder that will alert the user after a specified delay or at a specific time. Use this when the user says things like 'remind me in 5 minutes', 'remind me at 3pm to call John', 'set a timer for 10 minutes', or 'remind me to take a break in 30 minutes'. Do NOT use this for calendar events — use add_google_calendar_event instead.",
        inputSchema: {
            json: JSON.stringify({
                type: "object",
                properties: {
                    message: {
                        type: "string",
                        description: "What to remind the user about.",
                    },
                    minutes: {
                        type: "number",
                        description: "Number of minutes from now to trigger the reminder. Use this OR remind_at, not both.",
                    },
                    remind_at: {
                        type: "string",
                        description: "Specific time to remind in ISO 8601 format with MST offset. Use this OR minutes, not both.",
                    },
                },
                required: ["message"],
            }),
        },
    },
};

// Tool definition for searching YouTube videos
const YOUTUBE_SEARCH_TOOL = {
    toolSpec: {
        name: "youtube_search",
        description:
            "Search YouTube for videos. Use this when the user asks to find a video, look up a tutorial, or search YouTube for something. Returns a list of videos with titles, channels, and links.",
        inputSchema: {
            json: JSON.stringify({
                type: "object",
                properties: {
                    query: {
                        type: "string",
                        description: "The search query.",
                    },
                    max_results: {
                        type: "number",
                        description: "Number of results to return. Defaults to 5.",
                    },
                },
                required: ["query"],
            }),
        },
    },
};

// Tool definition for summarizing a YouTube video transcript
const YOUTUBE_SUMMARIZE_TOOL = {
    toolSpec: {
        name: "youtube_summarize",
        description:
            "Fetch the transcript/captions of a YouTube video and summarize it. Use this when the user asks to summarize a YouTube video, wants to know what a video is about, or says 'summarize this video'. Requires a YouTube video URL or video ID.",
        inputSchema: {
            json: JSON.stringify({
                type: "object",
                properties: {
                    video_url: {
                        type: "string",
                        description: "YouTube video URL or video ID (e.g. https://youtube.com/watch?v=abc123 or just abc123).",
                    },
                },
                required: ["video_url"],
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
        timezone: "America/Denver",
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

// ── Google Calendar Events ──

async function listGoogleCalendarEvents({ date, days }) {
    const auth = getGoogleAuth();
    const calendar = google.calendar({ version: "v3", auth });

    const numDays = days || 1;
    const startDate = date ? new Date(date + "T00:00:00-07:00") : new Date();
    startDate.setHours(0, 0, 0, 0);
    const endDate = new Date(startDate.getTime() + numDays * 24 * 60 * 60 * 1000);

    try {
        const res = await calendar.events.list({
            calendarId: "primary",
            timeMin: startDate.toISOString(),
            timeMax: endDate.toISOString(),
            maxResults: 20,
            singleEvents: true,
            orderBy: "startTime",
        });

        const events = (res.data.items || []).map((e) => ({
            title: e.summary || "(No title)",
            start: e.start.dateTime || e.start.date,
            end: e.end.dateTime || e.end.date,
            meet_link: e.hangoutLink || null,
            location: e.location || null,
        }));

        return { success: true, events, total: events.length };
    } catch (err) {
        console.error("Google Calendar list error:", err.message);
        return { success: false, error: err.message, events: [] };
    }
}

// ── Google Meet (via Calendar) ──

async function checkCalendarConflicts(auth, start, end) {
    const calendar = google.calendar({ version: "v3", auth });
    try {
        const res = await calendar.events.list({
            calendarId: "primary",
            timeMin: start.toISOString(),
            timeMax: end.toISOString(),
            singleEvents: true,
            orderBy: "startTime",
        });
        return (res.data.items || []).map((e) => ({
            title: e.summary || "(No title)",
            start: e.start.dateTime || e.start.date,
            end: e.end.dateTime || e.end.date,
        }));
    } catch (err) {
        console.error("Conflict check error:", err.message);
        return [];
    }
}

async function createGoogleMeet({ topic, start_time, duration, attendees, force }) {
    const auth = getGoogleAuth();
    const calendar = google.calendar({ version: "v3", auth });

    const durationMin = duration || 30;
    const start = start_time ? new Date(start_time) : new Date(Date.now() + 5 * 60 * 1000);
    const end = new Date(start.getTime() + durationMin * 60 * 1000);

    // Check for conflicts unless force is true
    if (!force) {
        const conflicts = await checkCalendarConflicts(auth, start, end);
        if (conflicts.length > 0) {
            return {
                success: false,
                conflict: true,
                conflicts,
                message: `There are ${conflicts.length} conflicting event(s) during this time. Ask the user if they want to proceed anyway.`,
            };
        }
    }

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

async function addGoogleCalendarEvent({ title, start_time, duration, description, location, attendees, force }) {
    const auth = getGoogleAuth();
    const calendar = google.calendar({ version: "v3", auth });

    const durationMin = duration || 60;
    const start = new Date(start_time);
    const end = new Date(start.getTime() + durationMin * 60 * 1000);

    // Check for conflicts unless force is true
    if (!force) {
        const conflicts = await checkCalendarConflicts(auth, start, end);
        if (conflicts.length > 0) {
            return {
                success: false,
                conflict: true,
                conflicts,
                message: `There are ${conflicts.length} conflicting event(s) during this time. Ask the user if they want to proceed anyway.`,
            };
        }
    }

    const event = {
        summary: title,
        start: { dateTime: start.toISOString(), timeZone: "America/Denver" },
        end: { dateTime: end.toISOString(), timeZone: "America/Denver" },
    };

    if (description) event.description = description;
    if (location) event.location = location;
    if (attendees) {
        event.attendees = attendees.split(",").map((e) => ({ email: e.trim() }));
    }

    try {
        const res = await calendar.events.insert({
            calendarId: "primary",
            resource: event,
            sendUpdates: attendees ? "all" : "none",
        });

        return {
            success: true,
            title: res.data.summary,
            start_time: res.data.start.dateTime,
            end_time: res.data.end.dateTime,
            duration: durationMin,
            event_id: res.data.id,
            location: res.data.location || null,
        };
    } catch (err) {
        console.error("Google Calendar add event error:", err.message);
        return { success: false, error: err.message };
    }
}

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

// ── YouTube Integration ──

function extractVideoId(input) {
    if (!input) return null;
    // Handle various YouTube URL formats
    const patterns = [
        /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/)([a-zA-Z0-9_-]{11})/,
        /^([a-zA-Z0-9_-]{11})$/, // bare video ID
    ];
    for (const p of patterns) {
        const match = input.match(p);
        if (match) return match[1];
    }
    return null;
}

async function searchYouTube(query, maxResults) {
    const apiKey = process.env.YOUTUBE_API_KEY;

    if (!apiKey) {
        // Fallback: try OAuth (needs youtube.readonly scope)
        try {
            const auth = getGoogleAuth();
            const youtube = google.youtube({ version: "v3", auth });
            const res = await youtube.search.list({
                part: "snippet",
                q: query,
                type: "video",
                maxResults: maxResults || 5,
            });
            const videos = (res.data.items || []).map((item) => ({
                video_id: item.id.videoId,
                title: item.snippet.title,
                channel: item.snippet.channelTitle,
                description: item.snippet.description,
                url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
                thumbnail: item.snippet.thumbnails?.medium?.url || null,
            }));
            return { success: true, videos, total: videos.length };
        } catch (err) {
            console.error("YouTube search error:", err.message);
            return { success: false, error: "YouTube API key not configured and OAuth lacks youtube scope. Add YOUTUBE_API_KEY to .env.", videos: [] };
        }
    }

    const youtube = google.youtube({ version: "v3", auth: apiKey });

    try {
        const res = await youtube.search.list({
            part: "snippet",
            q: query,
            type: "video",
            maxResults: maxResults || 5,
        });

        const videos = (res.data.items || []).map((item) => ({
            video_id: item.id.videoId,
            title: item.snippet.title,
            channel: item.snippet.channelTitle,
            description: item.snippet.description,
            url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
            thumbnail: item.snippet.thumbnails?.medium?.url || null,
        }));

        return { success: true, videos, total: videos.length };
    } catch (err) {
        console.error("YouTube search error:", err.message);
        return { success: false, error: err.message, videos: [] };
    }
}

function decodeXmlEntities(str) {
    return str
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
}

async function summarizeYouTubeVideo(videoUrl, bedrockClient) {
    const videoId = extractVideoId(videoUrl);
    if (!videoId) {
        return { success: false, error: "Could not extract video ID from the provided URL." };
    }

    // Fetch video metadata
    let videoTitle = "Unknown Video";
    try {
        const auth = getGoogleAuth();
        const youtube = google.youtube({ version: "v3", auth });
        const meta = await youtube.videos.list({ part: "snippet", id: videoId });
        if (meta.data.items && meta.data.items.length > 0) {
            videoTitle = meta.data.items[0].snippet.title;
        }
    } catch (e) {
        console.error("YouTube metadata fetch error:", e.message);
    }

    // Fetch transcript via YouTube's innertube API
    let transcript;
    try {
        const playerResp = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "User-Agent": "com.google.android.youtube/20.10.38 (Linux; U; Android 14)",
            },
            body: JSON.stringify({
                context: { client: { clientName: "ANDROID", clientVersion: "20.10.38" } },
                videoId,
            }),
        });

        if (!playerResp.ok) {
            return { success: false, error: "Failed to fetch video data from YouTube." };
        }

        const playerData = await playerResp.json();
        const captionTracks = playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks;

        if (!Array.isArray(captionTracks) || captionTracks.length === 0) {
            return { success: false, error: "No captions available for this video." };
        }

        const trackUrl = captionTracks[0].baseUrl;
        const captionResp = await fetch(trackUrl, {
            headers: { "User-Agent": "Mozilla/5.0" },
        });

        if (!captionResp.ok) {
            return { success: false, error: "Failed to fetch captions." };
        }

        const captionXml = await captionResp.text();

        // Parse XML captions — handles both <text> and <p><s> formats
        const textMatches = [...captionXml.matchAll(/<text[^>]*>([^<]*)<\/text>/g)];
        if (textMatches.length > 0) {
            transcript = textMatches.map((m) => decodeXmlEntities(m[1])).join(" ");
        } else {
            const pMatches = [...captionXml.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)];
            transcript = pMatches.map((m) => {
                const inner = m[1].replace(/<[^>]+>/g, "");
                return decodeXmlEntities(inner);
            }).join(" ");
        }
    } catch (err) {
        console.error("YouTube transcript error:", err.message);
        return { success: false, error: "Could not fetch transcript. The video may not have captions available." };
    }

    if (!transcript || transcript.trim().length === 0) {
        return { success: false, error: "Video transcript is empty." };
    }

    // Truncate if very long (keep first ~15k chars)
    const trimmed = transcript.length > 15000 ? transcript.substring(0, 15000) + "..." : transcript;

    // Summarize with Nova
    try {
        const command = new ConverseCommand({
            modelId: GROUNDING_MODEL_ID,
            messages: [
                {
                    role: "user",
                    content: [
                        {
                            text: `Summarize the following YouTube video transcript concisely. Include:
- **Overview**: 2-3 sentence summary of what the video covers
- **Key Points**: bullet points of the main topics discussed
- **Takeaways**: any actionable insights or conclusions

Video: "${videoTitle}"

Transcript:
${trimmed}`,
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

        return {
            success: true,
            video_id: videoId,
            title: videoTitle,
            url: `https://www.youtube.com/watch?v=${videoId}`,
            summary: summary || "Failed to generate summary.",
        };
    } catch (err) {
        console.error("YouTube summarization error:", err.message);
        return { success: false, error: err.message };
    }
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
    activeClients.add(ws);

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
                                    tools: [WEB_SEARCH_TOOL, ZOOM_MEETING_TOOL, ZOOM_INSTANT_MEETING_TOOL, ZOOM_LIST_MEETINGS_TOOL, GOOGLE_CALENDAR_LIST_TOOL, GOOGLE_CALENDAR_ADD_TOOL, GOOGLE_MEET_TOOL, SUMMARIZE_MEETING_TOOL, SET_REMINDER_TOOL, YOUTUBE_SEARCH_TOOL, YOUTUBE_SUMMARIZE_TOOL],
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
                                    `You are a friendly assistant with web search, Zoom meeting, Google Calendar, Google Meet, reminders, YouTube, and meeting summary capabilities. Today's date is ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "America/Denver" })}. The current time is ${new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Denver" })} MST. The user and you will engage in a spoken dialog exchanging the transcripts of a natural real-time conversation. Keep your responses short, generally two or three sentences for chatty scenarios. When the user asks about current events, news, weather, real-time information, or anything you're unsure about, use the web_search tool to look it up. Always mention your sources briefly when using search results. When the user asks to schedule or create a Zoom meeting, use the schedule_zoom_meeting tool. Always assume the user's timezone is MST (Mountain Standard Time, UTC-7) and convert times to ISO 8601 with the MST offset. Always use the current year when scheduling meetings. When the user wants to start an instant call or join a Zoom right now, use the instant_zoom_meeting tool. When the user asks to see or list their meetings, use the list_zoom_meetings tool. When the user asks about their calendar, schedule, what meetings they have, or whether they are free, use the list_google_calendar_events tool. When the user asks to add, create, or put an event on their calendar (that is not a Google Meet), use the add_google_calendar_event tool. When the user asks to create or schedule a Google Meet, use the create_google_meet tool. When the user asks to summarize a meeting, get meeting notes, or send a meeting summary to Slack, use the summarize_meeting tool. Ask if they want it posted to Slack. When the user asks to set a reminder, be reminded about something, or set a timer, use the set_reminder tool. If they say "remind me in X minutes", set minutes to X. If they say "remind me at 3pm", convert to ISO 8601 MST and use remind_at. When the user asks to find or search for a YouTube video, use the youtube_search tool. When the user asks to summarize a YouTube video or wants to know what a video is about, use the youtube_summarize tool. Do not read out meeting links, IDs, or full URLs. Ask for a topic if the user doesn't provide one.`,
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
                                    console.log("Transcript fetch result:", transcriptResult.success, transcriptResult.error || "");
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
                                        if (params.post_to_slack === true || params.post_to_slack === "true") {
                                            const slackMessage = `📋 *Meeting Summary*\n_${transcriptResult.fileName}_\n\n${summary}`;
                                            const slackResult = await postToSlack(slackMessage);
                                            console.log("Slack post result:", slackResult);
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
                            } else if (toolName === "list_google_calendar_events") {
                                try {
                                    const params = JSON.parse(toolContent);
                                    console.log("Listing Google Calendar events:", params);

                                    const listResult = await listGoogleCalendarEvents(params);
                                    console.log("Google Calendar list result:", listResult.total, "events");

                                    if (ws.readyState === WebSocket.OPEN) {
                                        ws.send(JSON.stringify({
                                            type: "google_calendar_events",
                                            ...listResult,
                                        }));
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
                                                            content: JSON.stringify(listResult),
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
                                    console.error("Google Calendar list error:", toolErr);
                                }
                            } else if (toolName === "add_google_calendar_event") {
                                try {
                                    const params = JSON.parse(toolContent);
                                    console.log("Adding Google Calendar event:", params);

                                    const addResult = await addGoogleCalendarEvent(params);
                                    console.log("Google Calendar add result:", addResult);

                                    if (ws.readyState === WebSocket.OPEN) {
                                        ws.send(JSON.stringify({
                                            type: "google_calendar_event_added",
                                            ...addResult,
                                        }));
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

                                    const safeAddResult = {
                                        success: addResult.success,
                                        title: addResult.title,
                                        start_time: addResult.start_time,
                                        end_time: addResult.end_time,
                                        duration: addResult.duration,
                                        location: addResult.location,
                                        conflict: addResult.conflict,
                                        conflicts: addResult.conflicts,
                                        message: addResult.message,
                                        error: addResult.error,
                                    };

                                    pushInput({
                                        chunk: {
                                            bytes: Buffer.from(
                                                JSON.stringify({
                                                    event: {
                                                        toolResult: {
                                                            promptName,
                                                            contentName: toolResultContentName,
                                                            content: JSON.stringify(safeAddResult),
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
                                    console.error("Google Calendar add event error:", toolErr);
                                }
                            } else if (toolName === "set_reminder") {
                                try {
                                    const params = JSON.parse(toolContent);
                                    console.log("Setting reminder:", params);

                                    const reminder = addReminder(params);
                                    const fireAt = new Date(reminder.fireAt);
                                    const delayMs = fireAt.getTime() - Date.now();
                                    const delayMin = Math.round(delayMs / 60000);

                                    const result = {
                                        success: true,
                                        message: reminder.message,
                                        fire_at: fireAt.toLocaleString("en-US", { timeZone: "America/Denver" }),
                                        minutes_from_now: delayMin,
                                    };

                                    if (ws.readyState === WebSocket.OPEN) {
                                        ws.send(JSON.stringify({
                                            type: "reminder_set",
                                            ...result,
                                        }));
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
                                                            content: JSON.stringify(result),
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
                                    console.error("Set reminder error:", toolErr);
                                }
                            } else if (toolName === "youtube_search") {
                                try {
                                    const params = JSON.parse(toolContent);
                                    console.log("YouTube search:", params.query);

                                    const searchResult = await searchYouTube(params.query, params.max_results);
                                    console.log("YouTube search result:", searchResult.total, "videos");

                                    if (ws.readyState === WebSocket.OPEN) {
                                        ws.send(JSON.stringify({
                                            type: "youtube_results",
                                            ...searchResult,
                                        }));
                                    }

                                    const toolResultContentName = randomId();

                                    // Send sanitized result to model (no thumbnails/URLs)
                                    const safeResult = {
                                        success: searchResult.success,
                                        total: searchResult.total,
                                        videos: (searchResult.videos || []).map((v) => ({
                                            title: v.title,
                                            channel: v.channel,
                                            video_id: v.video_id,
                                        })),
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
                                    console.error("YouTube search error:", toolErr);
                                }
                            } else if (toolName === "youtube_summarize") {
                                try {
                                    const params = JSON.parse(toolContent);
                                    console.log("YouTube summarize:", params.video_url);

                                    if (ws.readyState === WebSocket.OPEN) {
                                        ws.send(JSON.stringify({ type: "tool_use", toolName: "youtube_summarize", content: toolContent }));
                                    }

                                    const summaryResult = await summarizeYouTubeVideo(params.video_url, converseClient);
                                    console.log("YouTube summary result:", summaryResult.success);

                                    if (summaryResult.success && ws.readyState === WebSocket.OPEN) {
                                        ws.send(JSON.stringify({
                                            type: "youtube_summary",
                                            ...summaryResult,
                                        }));
                                    }

                                    const toolResultContentName = randomId();

                                    const safeResult = {
                                        success: summaryResult.success,
                                        title: summaryResult.title,
                                        summary_preview: summaryResult.summary ? summaryResult.summary.substring(0, 500) : undefined,
                                        error: summaryResult.error,
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
                                    console.error("YouTube summarize error:", toolErr);
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
        activeClients.delete(ws);
        isActive = false;
        pushInput(null);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Nova Sonic web app running at http://localhost:${PORT}`);
});
