const https = require("https");

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
        type: start_time ? 2 : 1,
        duration: duration || 30,
        timezone: "America/Denver",
        settings: {
            join_before_host: true,
            waiting_room: false,
            auto_recording: "none",
        },
    };

    if (start_time) meetingData.start_time = start_time;

    const body = JSON.stringify(meetingData);

    return new Promise((resolve) => {
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
                            resolve({ success: false, error: json.message || "Failed to create meeting" });
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

    return new Promise((resolve) => {
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

module.exports = { createZoomMeeting, listZoomMeetings };
