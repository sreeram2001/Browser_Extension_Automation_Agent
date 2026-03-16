const { google } = require("googleapis");
const { ConverseCommand } = require("@aws-sdk/client-bedrock-runtime");
const { getGoogleAuth } = require("./google-auth");

function extractVideoId(input) {
    if (!input) return null;
    const patterns = [
        /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/)([a-zA-Z0-9_-]{11})/,
        /^([a-zA-Z0-9_-]{11})$/,
    ];
    for (const p of patterns) {
        const match = input.match(p);
        if (match) return match[1];
    }
    return null;
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

async function searchYouTube(query, maxResults) {
    const apiKey = process.env.YOUTUBE_API_KEY;

    if (!apiKey) {
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

async function summarizeYouTubeVideo(videoUrl, bedrockClient, groundingModelId) {
    const videoId = extractVideoId(videoUrl);
    if (!videoId) {
        return { success: false, error: "Could not extract video ID from the provided URL." };
    }

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

    const trimmed = transcript.length > 15000 ? transcript.substring(0, 15000) + "..." : transcript;

    try {
        const command = new ConverseCommand({
            modelId: groundingModelId,
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

module.exports = { searchYouTube, summarizeYouTubeVideo };
