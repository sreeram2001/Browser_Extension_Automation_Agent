const { google } = require("googleapis");
const { getGoogleAuth } = require("./google-auth");

async function fetchLatestMeetTranscript() {
    const auth = getGoogleAuth();
    const drive = google.drive({ version: "v3", auth });

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

    const content = await drive.files.export({
        fileId: latest.id,
        mimeType: "text/plain",
    });

    return {
        success: true,
        fileName: latest.name,
        modifiedTime: latest.modifiedTime,
        transcript: content.data.substring(0, 15000),
    };
}

module.exports = { fetchLatestMeetTranscript };
