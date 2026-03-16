const WEB_SEARCH_TOOL = {
    toolSpec: {
        name: "web_search",
        description:
            "Search the web for current, real-time information. Use this tool when the user asks about recent events, news, weather, stock prices, sports scores, or any topic that requires up-to-date information beyond your training data.",
        inputSchema: {
            json: JSON.stringify({
                type: "object",
                properties: {
                    query: { type: "string", description: "The search query to look up on the web" },
                },
                required: ["query"],
            }),
        },
    },
};

const ZOOM_MEETING_TOOL = {
    toolSpec: {
        name: "schedule_zoom_meeting",
        description:
            "Schedule a Zoom meeting. Use this tool when the user asks to create, schedule, or set up a Zoom meeting or video call.",
        inputSchema: {
            json: JSON.stringify({
                type: "object",
                properties: {
                    topic: { type: "string", description: "The meeting topic or title" },
                    duration: { type: "number", description: "Meeting duration in minutes. Defaults to 30." },
                    start_time: { type: "string", description: "Meeting start time in ISO 8601 format with MST offset (e.g. 2025-03-15T14:00:00-07:00). If not provided, creates an instant meeting." },
                },
                required: ["topic"],
            }),
        },
    },
};

const ZOOM_LIST_MEETINGS_TOOL = {
    toolSpec: {
        name: "list_zoom_meetings",
        description:
            "List upcoming scheduled Zoom meetings. Use this tool when the user asks to see their meetings, check their schedule, or asks 'what meetings do I have'.",
        inputSchema: {
            json: JSON.stringify({ type: "object", properties: {}, required: [] }),
        },
    },
};

const ZOOM_INSTANT_MEETING_TOOL = {
    toolSpec: {
        name: "instant_zoom_meeting",
        description:
            "Create an instant Zoom meeting and join it immediately. Use this tool when the user says things like 'start a Zoom call', 'create an instant meeting', 'let's hop on a call', 'start a zoom meeting', or 'join a Zoom now'.",
        inputSchema: {
            json: JSON.stringify({
                type: "object",
                properties: {
                    topic: { type: "string", description: "Optional meeting topic. Defaults to 'Instant Meeting'." },
                },
                required: [],
            }),
        },
    },
};

const GOOGLE_CALENDAR_LIST_TOOL = {
    toolSpec: {
        name: "list_google_calendar_events",
        description:
            "List upcoming events from the user's Google Calendar. Use this when the user asks 'what's on my calendar', 'what meetings do I have today', 'am I free tomorrow', or 'show my schedule'.",
        inputSchema: {
            json: JSON.stringify({
                type: "object",
                properties: {
                    date: { type: "string", description: "Optional date to check in ISO 8601 format (e.g. 2025-07-14). If not provided, shows today's events." },
                    days: { type: "number", description: "Number of days to look ahead. Defaults to 1." },
                },
                required: [],
            }),
        },
    },
};

const GOOGLE_CALENDAR_ADD_TOOL = {
    toolSpec: {
        name: "add_google_calendar_event",
        description:
            "Add a new event to the user's Google Calendar. Use this when the user asks to 'add an event', 'create a calendar event', 'block time', 'schedule something on my calendar', or 'put X on my calendar'. Do NOT use this for Google Meet meetings — use create_google_meet instead. This tool automatically checks for scheduling conflicts. If a conflict is found, tell the user about the conflicting events and ask if they want to proceed. If they confirm, call this tool again with force set to true.",
        inputSchema: {
            json: JSON.stringify({
                type: "object",
                properties: {
                    title: { type: "string", description: "The event title or summary." },
                    start_time: { type: "string", description: "Event start time in ISO 8601 format with MST offset (e.g. 2025-03-15T14:00:00-07:00)." },
                    duration: { type: "number", description: "Event duration in minutes. Defaults to 60." },
                    description: { type: "string", description: "Optional event description or notes." },
                    location: { type: "string", description: "Optional event location." },
                    attendees: { type: "string", description: "Comma-separated email addresses of attendees. Optional." },
                    force: { type: "boolean", description: "Set to true to create the event even if there are conflicts. Only use after the user confirms." },
                },
                required: ["title", "start_time"],
            }),
        },
    },
};

const GOOGLE_MEET_TOOL = {
    toolSpec: {
        name: "create_google_meet",
        description:
            "Create a Google Meet meeting by adding a calendar event with a Google Meet link. Use this when the user asks to create a Google Meet, schedule a Google Meet, or start a Google Meet call. This tool automatically checks for scheduling conflicts. If a conflict is found, tell the user about the conflicting events and ask if they want to proceed. If they confirm, call this tool again with force set to true.",
        inputSchema: {
            json: JSON.stringify({
                type: "object",
                properties: {
                    topic: { type: "string", description: "The meeting topic or title." },
                    start_time: { type: "string", description: "Meeting start time in ISO 8601 format with MST offset (e.g. 2025-03-15T14:00:00-07:00). If not provided, starts in 5 minutes." },
                    duration: { type: "number", description: "Meeting duration in minutes. Defaults to 30." },
                    attendees: { type: "string", description: "Comma-separated email addresses of attendees to invite. Optional." },
                    force: { type: "boolean", description: "Set to true to create the meeting even if there are conflicts. Only use after the user confirms." },
                },
                required: ["topic"],
            }),
        },
    },
};

const GOOGLE_MEET_INSTANT_TOOL = {
    toolSpec: {
        name: "instant_google_meet",
        description:
            "Create an instant Google Meet meeting and join it immediately. Use this tool when the user says things like 'start a Google Meet', 'start an instant Google Meet', 'create an instant Meet', 'hop on a Google Meet', 'start a Meet now', or 'join a Google Meet now'. Do NOT use the Zoom instant meeting tool when the user specifically asks for Google Meet.",
        inputSchema: {
            json: JSON.stringify({
                type: "object",
                properties: {
                    topic: { type: "string", description: "Optional meeting topic. Defaults to 'Instant Meeting'." },
                },
                required: [],
            }),
        },
    },
};

const SUMMARIZE_MEETING_TOOL = {
    toolSpec: {
        name: "summarize_meeting",
        description:
            "Fetch the latest Google Meet transcript from Google Drive, summarize it, and optionally post the summary to Slack. Use this when the user says things like 'summarize my last meeting', 'get my meeting notes', or 'send meeting summary to Slack'.",
        inputSchema: {
            json: JSON.stringify({
                type: "object",
                properties: {
                    post_to_slack: { type: "boolean", description: "Whether to also post the summary to Slack. Defaults to false." },
                },
                required: [],
            }),
        },
    },
};

const SET_REMINDER_TOOL = {
    toolSpec: {
        name: "set_reminder",
        description:
            "Set a reminder that will alert the user after a specified delay or at a specific time. Use this when the user says things like 'remind me in 5 minutes', 'remind me at 3pm to call John', 'set a timer for 10 minutes', or 'remind me to take a break in 30 minutes'. Do NOT use this for calendar events — use add_google_calendar_event instead.",
        inputSchema: {
            json: JSON.stringify({
                type: "object",
                properties: {
                    message: { type: "string", description: "What to remind the user about." },
                    minutes: { type: "number", description: "Number of minutes from now to trigger the reminder. Use this OR remind_at, not both." },
                    remind_at: { type: "string", description: "Specific time to remind in ISO 8601 format with MST offset. Use this OR minutes, not both." },
                },
                required: ["message"],
            }),
        },
    },
};

const YOUTUBE_SEARCH_TOOL = {
    toolSpec: {
        name: "youtube_search",
        description:
            "Search YouTube for videos. Use this when the user asks to find a video, look up a tutorial, or search YouTube for something. Returns a list of videos with titles, channels, and links.",
        inputSchema: {
            json: JSON.stringify({
                type: "object",
                properties: {
                    query: { type: "string", description: "The search query." },
                    max_results: { type: "number", description: "Number of results to return. Defaults to 5." },
                },
                required: ["query"],
            }),
        },
    },
};

const YOUTUBE_SUMMARIZE_TOOL = {
    toolSpec: {
        name: "youtube_summarize",
        description:
            "Fetch the transcript/captions of a YouTube video and summarize it. Use this when the user asks to summarize a YouTube video, wants to know what a video is about, or says 'summarize this video'. Requires a YouTube video URL or video ID.",
        inputSchema: {
            json: JSON.stringify({
                type: "object",
                properties: {
                    video_url: { type: "string", description: "YouTube video URL or video ID (e.g. https://youtube.com/watch?v=abc123 or just abc123)." },
                },
                required: ["video_url"],
            }),
        },
    },
};

const CREATE_GOOGLE_TASKS_TOOL = {
    toolSpec: {
        name: "create_google_tasks",
        description:
            "Create tasks in Google Tasks from a list of action items. Use this when the user asks to 'create tasks from the meeting', 'add action items to my tasks', 'turn those into tasks', or after summarizing a meeting when the user wants to track action items. You can also use this standalone when the user asks to add a task or to-do.",
        inputSchema: {
            json: JSON.stringify({
                type: "object",
                properties: {
                    tasks: {
                        type: "array",
                        description: "Array of task objects to create.",
                        items: {
                            type: "object",
                            properties: {
                                title: { type: "string", description: "The task title or action item text." },
                                notes: { type: "string", description: "Optional notes or context for the task." },
                                due: { type: "string", description: "Optional due date in ISO 8601 format (e.g. 2025-07-20T00:00:00-07:00)." },
                            },
                            required: ["title"],
                        },
                    },
                    task_list: { type: "string", description: "Name of the task list to add to. Defaults to the user's primary task list." },
                },
                required: ["tasks"],
            }),
        },
    },
};

const ALL_TOOLS = [
    WEB_SEARCH_TOOL, ZOOM_MEETING_TOOL, ZOOM_INSTANT_MEETING_TOOL, ZOOM_LIST_MEETINGS_TOOL,
    GOOGLE_CALENDAR_LIST_TOOL, GOOGLE_CALENDAR_ADD_TOOL, GOOGLE_MEET_TOOL, GOOGLE_MEET_INSTANT_TOOL,
    SUMMARIZE_MEETING_TOOL, SET_REMINDER_TOOL, YOUTUBE_SEARCH_TOOL, YOUTUBE_SUMMARIZE_TOOL,
    CREATE_GOOGLE_TASKS_TOOL,
];

module.exports = { ALL_TOOLS };
