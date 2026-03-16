const crypto = require("crypto");
const { google } = require("googleapis");
const { getGoogleAuth } = require("./google-auth");

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

async function addGoogleCalendarEvent({ title, start_time, duration, description, location, attendees, force }) {
    const auth = getGoogleAuth();
    const calendar = google.calendar({ version: "v3", auth });

    const durationMin = duration || 60;
    const start = new Date(start_time);
    const end = new Date(start.getTime() + durationMin * 60 * 1000);

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

async function createGoogleMeet({ topic, start_time, duration, attendees, force }) {
    const auth = getGoogleAuth();
    const calendar = google.calendar({ version: "v3", auth });

    const durationMin = duration || 30;
    const start = start_time ? new Date(start_time) : new Date(Date.now() + 5 * 60 * 1000);
    const end = new Date(start.getTime() + durationMin * 60 * 1000);

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

module.exports = { listGoogleCalendarEvents, addGoogleCalendarEvent, createGoogleMeet };
