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

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, "public")));

const REGION = process.env.AWS_REGION || "us-east-1";
const MODEL_ID = "amazon.nova-sonic-v1:0";
const GROUNDING_MODEL_ID = process.env.GROUNDING_MODEL_ID || "us.amazon.nova-lite-v1:0";
const AWS_PROFILE = "uoc";
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
                            "Meeting start time in ISO 8601 format (e.g. 2025-03-15T14:00:00Z). If not provided, creates an instant meeting.",
                    },
                },
                required: ["topic"],
            }),
        },
    },
};

// Perform web grounding via Nova's built-in nova_grounding system tool (Converse API)
async function performWebGrounding(query, bedrockClient) {
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

        return {
            query,
            summary: (text || "No results found.").substring(0, 2000),
            citations,
        };
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
        timezone: "UTC",
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

// Separate client for Converse API calls (nova_grounding) — uses default HTTPS handler
function createConverseClient() {
    return new BedrockRuntimeClient({
        region: REGION,
        credentials: fromIni({ profile: AWS_PROFILE }),
    });
}

function randomId() {
    return crypto.randomUUID();
}

wss.on("connection", (ws) => {
    console.log("Client connected");

    let bedrockClient = createBedrockClient();
    let converseClient = createConverseClient();
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
                                    tools: [WEB_SEARCH_TOOL, ZOOM_MEETING_TOOL],
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
                                    "You are a friendly assistant with web search and Zoom meeting capabilities. The user and you will engage in a spoken dialog exchanging the transcripts of a natural real-time conversation. Keep your responses short, generally two or three sentences for chatty scenarios. When the user asks about current events, news, weather, real-time information, or anything you're unsure about, use the web_search tool to look it up. Always mention your sources briefly when using search results. When the user asks to schedule or create a Zoom meeting, use the schedule_zoom_meeting tool. Ask for a topic if the user doesn't provide one.",
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

                                    // Send tool result back to Nova Sonic
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
                                                            content: JSON.stringify(meetingResult),
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
