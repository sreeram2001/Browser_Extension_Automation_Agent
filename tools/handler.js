const { performWebGrounding } = require("../services/grounding");
const { createZoomMeeting, listZoomMeetings } = require("../services/zoom");
const { listGoogleCalendarEvents, addGoogleCalendarEvent, createGoogleMeet } = require("../services/google-calendar");
const { createGoogleTasks } = require("../services/google-tasks");
const { fetchLatestMeetTranscript } = require("../services/google-drive");
const { summarizeMeetingTranscript } = require("../services/summarize");
const { searchYouTube, summarizeYouTubeVideo } = require("../services/youtube");
const { postToSlack } = require("../services/slack");
const { addReminder } = require("../services/reminders");

function sanitizeMeetingResult(result) {
    const { join_url, passcode, meeting_id, ...safe } = result;
    return safe;
}

/**
 * Handle a tool use request from Nova Sonic.
 * Returns { clientMessage, toolResponse } where:
 *   - clientMessage: object to send to the browser (or null)
 *   - toolResponse: string JSON to send back to the model
 */
async function handleToolUse(toolName, toolContent, converseClient, groundingModelId) {
    const params = JSON.parse(toolContent);

    switch (toolName) {
        case "web_search": {
            const result = await performWebGrounding(params.query, converseClient, groundingModelId);
            console.log(`Grounding results for "${params.query}":`, result.citations.length, "citations");
            return {
                clientMessage: { type: "search_results", query: params.query, summary: result.summary, citations: result.citations },
                toolResponse: JSON.stringify(result),
            };
        }

        case "schedule_zoom_meeting": {
            console.log("Creating Zoom meeting:", params);
            const result = await createZoomMeeting(params);
            console.log("Zoom meeting result:", result);
            return {
                clientMessage: { type: "zoom_meeting", ...result },
                toolResponse: JSON.stringify(sanitizeMeetingResult(result)),
            };
        }

        case "instant_zoom_meeting": {
            console.log("Creating instant Zoom meeting:", params);
            const result = await createZoomMeeting({ topic: params.topic || "Instant Meeting" });
            console.log("Instant Zoom meeting result:", result);
            return {
                clientMessage: { type: "zoom_meeting", auto_join: true, ...result },
                toolResponse: JSON.stringify(sanitizeMeetingResult(result)),
            };
        }

        case "list_zoom_meetings": {
            console.log("Listing Zoom meetings");
            const result = await listZoomMeetings();
            console.log("Zoom meetings list:", result.total, "meetings");
            return {
                clientMessage: { type: "zoom_meetings_list", ...result },
                toolResponse: JSON.stringify({
                    success: result.success,
                    total: result.total,
                    meetings: (result.meetings || []).map(m => ({
                        topic: m.topic, start_time: m.start_time, duration: m.duration,
                    })),
                }),
            };
        }

        case "list_google_calendar_events": {
            console.log("Listing Google Calendar events:", params);
            const result = await listGoogleCalendarEvents(params);
            console.log("Google Calendar list result:", result.total, "events");
            return {
                clientMessage: { type: "google_calendar_events", ...result },
                toolResponse: JSON.stringify(result),
            };
        }

        case "add_google_calendar_event": {
            console.log("Adding Google Calendar event:", params);
            const result = await addGoogleCalendarEvent(params);
            console.log("Google Calendar add result:", result);
            const msgType = result.conflict ? "google_calendar_event_added" : "google_calendar_event_added";
            return {
                clientMessage: { type: "google_calendar_event_added", ...result },
                toolResponse: JSON.stringify(result),
            };
        }

        case "create_google_meet": {
            console.log("Creating Google Meet:", params);
            const result = await createGoogleMeet(params);
            console.log("Google Meet result:", result);
            return {
                clientMessage: { type: "google_meet", ...result },
                toolResponse: JSON.stringify({
                    success: result.success, topic: result.topic,
                    start_time: result.start_time, duration: result.duration,
                    error: result.error,
                }),
            };
        }

        case "instant_google_meet": {
            console.log("Creating instant Google Meet:", params);
            const result = await createGoogleMeet({ topic: params.topic || "Instant Meeting", force: true });
            console.log("Instant Google Meet result:", result);
            return {
                clientMessage: { type: "google_meet", auto_join: true, ...result },
                toolResponse: JSON.stringify({
                    success: result.success, topic: result.topic,
                    start_time: result.start_time, duration: result.duration,
                    error: result.error,
                }),
            };
        }

        case "summarize_meeting": {
            console.log("Summarizing meeting, post_to_slack:", params.post_to_slack);
            const transcriptResult = await fetchLatestMeetTranscript();
            console.log("Transcript fetch result:", transcriptResult.success, transcriptResult.error || "");

            if (!transcriptResult.success) {
                return {
                    clientMessage: null,
                    toolResponse: JSON.stringify({ success: false, error: transcriptResult.error }),
                };
            }

            const summary = await summarizeMeetingTranscript(transcriptResult.transcript, converseClient, groundingModelId);
            const toolResponse = { success: true, fileName: transcriptResult.fileName, summary };

            if (params.post_to_slack === true || params.post_to_slack === "true") {
                const slackMessage = `📋 *Meeting Summary*\n_${transcriptResult.fileName}_\n\n${summary}`;
                const slackResult = await postToSlack(slackMessage);
                console.log("Slack post result:", slackResult);
                toolResponse.slack_posted = slackResult.success;
                if (!slackResult.success) toolResponse.slack_error = slackResult.error;
            }

            return {
                clientMessage: {
                    type: "meeting_summary",
                    fileName: transcriptResult.fileName,
                    summary,
                    slack_posted: toolResponse.slack_posted || false,
                },
                toolResponse: JSON.stringify({
                    success: true,
                    fileName: toolResponse.fileName,
                    summary_preview: summary.substring(0, 500),
                    slack_posted: toolResponse.slack_posted,
                }),
            };
        }

        case "set_reminder": {
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
            return {
                clientMessage: { type: "reminder_set", ...result },
                toolResponse: JSON.stringify(result),
            };
        }

        case "create_google_tasks": {
            console.log("Creating Google Tasks:", params.tasks?.length, "tasks");
            const result = await createGoogleTasks(params);
            console.log("Google Tasks result:", result.total, "created");
            return {
                clientMessage: { type: "google_tasks_created", ...result },
                toolResponse: JSON.stringify(result),
            };
        }

        case "youtube_search": {
            console.log("YouTube search:", params.query);
            const result = await searchYouTube(params.query, params.max_results);
            console.log("YouTube search result:", result.total, "videos");
            return {
                clientMessage: { type: "youtube_results", ...result },
                toolResponse: JSON.stringify({
                    success: result.success, total: result.total,
                    videos: (result.videos || []).map(v => ({
                        title: v.title, channel: v.channel, description: v.description,
                    })),
                }),
            };
        }

        case "youtube_summarize": {
            console.log("YouTube summarize:", params.video_url);
            const result = await summarizeYouTubeVideo(params.video_url, converseClient, groundingModelId);
            console.log("YouTube summarize result:", result.success);
            const safeResult = {
                success: result.success, title: result.title,
                summary: result.summary, error: result.error,
            };
            return {
                clientMessage: { type: "youtube_summary", ...result },
                toolResponse: JSON.stringify(safeResult),
            };
        }

        default:
            console.warn(`Unknown tool: ${toolName}`);
            return {
                clientMessage: null,
                toolResponse: JSON.stringify({ error: `Unknown tool: ${toolName}` }),
            };
    }
}

module.exports = { handleToolUse };
