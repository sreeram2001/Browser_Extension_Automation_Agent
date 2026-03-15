const micBtn = document.getElementById("mic-btn");
const statusEl = document.getElementById("status");
const transcriptEl = document.getElementById("transcript");
const visualizerEl = document.getElementById("visualizer");

// Create visualizer bars
for (let i = 0; i < 20; i++) {
    const bar = document.createElement("div");
    bar.className = "bar";
    visualizerEl.appendChild(bar);
}
const bars = visualizerEl.querySelectorAll(".bar");

// ── State ──
let ws = null;
let assistantTextSeen = new Set();
let mediaStream = null;
let audioContext = null;
let processorNode = null;
let isRecording = false;
let playbackContext = null;
let nextPlayTime = 0;
let silenceTimer = null;
let wakeWordRecognition = null;
let wakeWordActive = false;

const INPUT_SAMPLE_RATE = 16000;
const OUTPUT_SAMPLE_RATE = 24000;
const WAKE_PHRASE = "sonic";
const SILENCE_TIMEOUT_MS = 10000; // end session after 10s of silence

// ── Wake Word Detection (Web Speech API) ──

function initWakeWord() {
    const SpeechRecognition =
        window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognition) {
        statusEl.textContent =
            "Wake word not supported in this browser. Use the mic button.";
        return;
    }

    wakeWordRecognition = new SpeechRecognition();
    wakeWordRecognition.continuous = true;
    wakeWordRecognition.interimResults = true;
    wakeWordRecognition.lang = "en-US";
    wakeWordRecognition.maxAlternatives = 3;

    wakeWordRecognition.onresult = (event) => {
        for (let i = event.resultIndex; i < event.results.length; i++) {
            // Check all alternatives for faster matching
            for (let alt = 0; alt < event.results[i].length; alt++) {
                const transcript = event.results[i][alt].transcript.toLowerCase().trim();
                if (transcript.includes(WAKE_PHRASE)) {
                    addSystemMessage("Wake word detected!");
                    stopWakeWordListening();
                    startRecording();
                    return;
                }
            }
        }
    };

    wakeWordRecognition.onerror = (event) => {
        // Restart immediately on recoverable errors
        if (event.error === "no-speech" || event.error === "aborted" || event.error === "network") {
            if (wakeWordActive && !isRecording) {
                try { wakeWordRecognition.start(); } catch (e) { }
            }
        }
    };

    wakeWordRecognition.onend = () => {
        // Auto-restart if we're still in listening mode
        if (wakeWordActive && !isRecording) {
            try {
                wakeWordRecognition.start();
            } catch (e) {
                // already started
            }
        }
    };
}

function startWakeWordListening() {
    if (!wakeWordRecognition) return;
    wakeWordActive = true;
    micBtn.classList.remove("active");
    micBtn.classList.add("listening");
    statusEl.textContent = 'Listening for "Sonic"...';
    try {
        wakeWordRecognition.start();
    } catch (e) {
        // already running
    }
}

function stopWakeWordListening() {
    wakeWordActive = false;
    micBtn.classList.remove("listening");
    if (wakeWordRecognition) {
        try {
            wakeWordRecognition.stop();
        } catch (e) {
            // not running
        }
    }
}

// ── Silence Detection ──

function resetSilenceTimer() {
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => {
        if (isRecording) {
            addSystemMessage("Agent stopped.");
            stopRecording();
        }
    }, SILENCE_TIMEOUT_MS);
}

function clearSilenceTimer() {
    if (silenceTimer) {
        clearTimeout(silenceTimer);
        silenceTimer = null;
    }
}

// ── Mic Button ──

micBtn.addEventListener("click", () => {
    if (isRecording) {
        stopRecording();
    } else {
        stopWakeWordListening();
        startRecording();
    }
});

// ── Recording (Nova Sonic session) ──

async function startRecording() {
    try {
        statusEl.textContent = "Requesting microphone access...";

        mediaStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                sampleRate: INPUT_SAMPLE_RATE,
                channelCount: 1,
                echoCancellation: true,
                noiseSuppression: true,
            },
        });

        audioContext = new AudioContext({ sampleRate: INPUT_SAMPLE_RATE });
        await audioContext.audioWorklet.addModule('audio-processor.js');
        const source = audioContext.createMediaStreamSource(mediaStream);
        processorNode = new AudioWorkletNode(audioContext, 'recorder-processor');

        playbackContext = new AudioContext({ sampleRate: OUTPUT_SAMPLE_RATE });
        nextPlayTime = 0;

        const protocol = location.protocol === "https:" ? "wss:" : "ws:";
        ws = new WebSocket(`${protocol}//${location.host}`);

        ws.onopen = () => {
            statusEl.textContent = "Connected. Speak now...";
            ws.send(JSON.stringify({ type: "start" }));

            source.connect(processorNode);
            processorNode.connect(audioContext.destination);

            // Start silence timer
            resetSilenceTimer();

            processorNode.port.onmessage = (e) => {
                if (!isRecording || !ws || ws.readyState !== WebSocket.OPEN) return;

                const float32 = e.data;

                // Check if there's actual audio (not silence)
                let rms = 0;
                for (let i = 0; i < float32.length; i++) rms += float32[i] * float32[i];
                rms = Math.sqrt(rms / float32.length);
                if (rms > 0.01) resetSilenceTimer(); // voice detected, reset timer

                const int16 = float32ToInt16(float32);
                const base64 = arrayBufferToBase64(int16.buffer);
                ws.send(JSON.stringify({ type: "audio", data: base64 }));

                updateVisualizer(float32);
            };
        };

        ws.onmessage = (event) => {
            const msg = JSON.parse(event.data);

            if (msg.type === "audio") {
                resetSilenceTimer(); // model is responding, keep alive
                playAudio(msg.data);
            } else if (msg.type === "text") {
                resetSilenceTimer();
                addTranscript(msg.role, msg.content);
            } else if (msg.type === "tool_use") {
                resetSilenceTimer();
                assistantTextSeen.clear();
                if (msg.toolName === "schedule_zoom_meeting") {
                    addSystemMessage("📅 Creating Zoom meeting...");
                } else {
                    addSystemMessage("🔍 Searching the web...");
                }
            } else if (msg.type === "search_results") {
                resetSilenceTimer();
                addSearchResults(msg.query, msg.summary, msg.citations);
            } else if (msg.type === "zoom_meeting") {
                resetSilenceTimer();
                addZoomMeeting(msg);
            } else if (msg.type === "zoom_meetings_list") {
                resetSilenceTimer();
                addZoomMeetingsList(msg);
            } else if (msg.type === "meeting_summary") {
                resetSilenceTimer();
                addMeetingSummary(msg);
            } else if (msg.type === "google_meet") {
                resetSilenceTimer();
                addGoogleMeet(msg);
            } else if (msg.type === "google_calendar_events") {
                resetSilenceTimer();
                addGoogleCalendarEvents(msg);
            } else if (msg.type === "google_calendar_event_added") {
                resetSilenceTimer();
                addGoogleCalendarEventAdded(msg);
            } else if (msg.type === "error") {
                statusEl.textContent = `Error: ${msg.message}`;
            } else if (msg.type === "session_end") {
                assistantTextSeen.clear();
                statusEl.textContent = "Session ended.";
            }
        };

        ws.onerror = () => {
            statusEl.textContent = "WebSocket error. Check server.";
        };

        ws.onclose = () => {
            if (isRecording) stopRecording();
        };

        isRecording = true;
        micBtn.classList.remove("listening");
        micBtn.classList.add("active");
    } catch (err) {
        statusEl.textContent = `Mic error: ${err.message}`;
        console.error(err);
        startWakeWordListening();
    }
}

function stopRecording() {
    isRecording = false;
    micBtn.classList.remove("active");
    clearSilenceTimer();

    bars.forEach((b) => (b.style.height = "4px"));

    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "stop" }));
        ws.close();
    }
    ws = null;

    if (processorNode) {
        processorNode.disconnect();
        processorNode = null;
    }
    if (audioContext) {
        audioContext.close();
        audioContext = null;
    }
    if (mediaStream) {
        mediaStream.getTracks().forEach((t) => t.stop());
        mediaStream = null;
    }

    // Go back to wake word listening
    startWakeWordListening();
}

// ── Audio Playback ──

function playAudio(base64Data) {
    if (!playbackContext) return;

    const raw = atob(base64Data);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);

    const int16 = new Int16Array(bytes.buffer);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768;

    const buffer = playbackContext.createBuffer(1, float32.length, OUTPUT_SAMPLE_RATE);
    buffer.getChannelData(0).set(float32);

    const source = playbackContext.createBufferSource();
    source.buffer = buffer;
    source.connect(playbackContext.destination);

    const now = playbackContext.currentTime;
    if (nextPlayTime < now) nextPlayTime = now;
    source.start(nextPlayTime);
    nextPlayTime += buffer.duration;
}

// ── Transcript ──

function addTranscript(role, content) {
    if (!content || content.trim() === "") return;
    if (content.includes('"interrupted"')) return;

    // Nova Sonic sends the text transcript alongside audio. It often sends
    // the same content multiple times (exact or as a growing cumulative string).
    // Deduplicate by checking if we've already shown this exact text or if
    // a previously shown text already contains this content.
    if (role === "ASSISTANT") {
        const trimmed = content.trim();
        // Skip if we've seen this exact text
        for (const seen of assistantTextSeen) {
            if (seen === trimmed) return;
            // Skip if a previous message already contains this text (subset)
            if (seen.includes(trimmed)) return;
        }
        // If this new text contains a previous message, remove the old one from DOM
        // (it was a partial that's now superseded by the full version)
        for (const seen of assistantTextSeen) {
            if (trimmed.includes(seen)) {
                assistantTextSeen.delete(seen);
                // Remove the old partial div from transcript
                const msgs = transcriptEl.querySelectorAll(".msg.assistant");
                for (const m of msgs) {
                    if (m.textContent.replace("Assistant", "").trim() === seen) {
                        m.remove();
                        break;
                    }
                }
            }
        }
        assistantTextSeen.add(trimmed);
    } else {
        assistantTextSeen.clear();
    }

    const roleLabel = role === "USER" ? "You" : "Assistant";
    const cssClass = role === "USER" ? "user" : "assistant";

    const div = document.createElement("div");
    div.className = `msg ${cssClass}`;
    div.innerHTML = `<span class="label">${roleLabel}</span>${escapeHtml(content)}`;
    transcriptEl.appendChild(div);
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function addSystemMessage(text) {
    const div = document.createElement("div");
    div.className = "msg system";
    div.textContent = text;
    transcriptEl.appendChild(div);
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function addSearchResults(query, summary, citations) {
    const div = document.createElement("div");
    div.className = "msg search-results";

    let html = `<span class="label">🌐 Web Grounding</span>`;
    if (citations && citations.length > 0) {
        html += `<div class="citations">`;
        const uniqueUrls = [...new Map(citations.map((c) => [c.url, c])).values()];
        uniqueUrls.forEach((c) => {
            const domain = c.domain || new URL(c.url).hostname;
            html += `<a href="${escapeHtml(c.url)}" target="_blank" rel="noopener" class="citation-link">${escapeHtml(domain)}</a>`;
        });
        html += `</div>`;
    }

    div.innerHTML = html;
    transcriptEl.appendChild(div);
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function addZoomMeeting(data) {
    const div = document.createElement("div");
    div.className = "msg zoom-meeting";

    if (data.success) {
        // Auto-open the join link if it's an instant meeting
        if (data.auto_join && data.join_url) {
            window.open(data.join_url, "_blank");
        }

        div.innerHTML =
            `<span class="label">📹 Zoom Meeting Created</span>` +
            `<div class="zoom-topic">${escapeHtml(data.topic)}</div>` +
            `<a href="${escapeHtml(data.join_url)}" target="_blank" rel="noopener" class="zoom-link">Join Meeting</a>` +
            (data.passcode ? `<div class="zoom-passcode">Passcode: ${escapeHtml(data.passcode)}</div>` : "");
    } else {
        div.innerHTML =
            `<span class="label">📹 Zoom</span>` +
            `<div class="zoom-error">Failed: ${escapeHtml(data.error || "Unknown error")}</div>`;
    }

    transcriptEl.appendChild(div);
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function addZoomMeetingsList(data) {
    const div = document.createElement("div");
    div.className = "msg zoom-meeting";

    if (data.success && data.meetings.length > 0) {
        let html = `<span class="label">📋 Upcoming Zoom Meetings (${data.total})</span>`;
        data.meetings.forEach((m) => {
            const time = m.start_time === "instant" ? "Instant" : new Date(m.start_time).toLocaleString();
            html += `<div style="margin: 8px 0; padding: 6px 0; border-bottom: 1px solid rgba(255,255,255,0.04);">`;
            html += `<div class="zoom-topic">${escapeHtml(m.topic)}</div>`;
            html += `<div style="font-size: 0.76rem; color: #6b7280;">${time} · ${m.duration} min</div>`;
            html += `<a href="${escapeHtml(m.join_url)}" target="_blank" rel="noopener" class="zoom-link" style="margin-top: 4px;">Join</a>`;
            html += `</div>`;
        });
        div.innerHTML = html;
    } else if (data.success) {
        div.innerHTML = `<span class="label">📋 Zoom Meetings</span><div style="color: #6b7280;">No upcoming meetings found.</div>`;
    } else {
        div.innerHTML = `<span class="label">📋 Zoom</span><div class="zoom-error">Failed: ${escapeHtml(data.error || "Unknown error")}</div>`;
    }

    transcriptEl.appendChild(div);
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function addGoogleMeet(data) {
    const div = document.createElement("div");
    div.className = "msg zoom-meeting";
    div.style.borderLeftColor = "#a78bfa";

    if (data.success) {
        const time = new Date(data.start_time).toLocaleString();
        div.innerHTML =
            `<span class="label" style="color: #a78bfa;">📹 Google Meet Created</span>` +
            `<div class="zoom-topic">${escapeHtml(data.topic)}</div>` +
            `<div style="font-size: 0.76rem; color: #6b7280;">${time} · ${data.duration} min</div>` +
            `<a href="${escapeHtml(data.meet_link)}" target="_blank" rel="noopener" class="zoom-link">Join Google Meet</a>`;
    } else {
        div.innerHTML =
            `<span class="label" style="color: #a78bfa;">📹 Google Meet</span>` +
            `<div class="zoom-error">Failed: ${escapeHtml(data.error || "Unknown error")}</div>`;
    }

    transcriptEl.appendChild(div);
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function addGoogleCalendarEvents(data) {
    const div = document.createElement("div");
    div.className = "msg calendar-events";

    if (data.success && data.events && data.events.length > 0) {
        let html = `<span class="label" style="color: #34d399;">📅 Calendar — ${data.total} event${data.total !== 1 ? "s" : ""}</span>`;
        data.events.forEach((e) => {
            const start = new Date(e.start);
            const end = new Date(e.end);
            const timeStr = start.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
            const endStr = end.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

            html += `<div class="calendar-event-item">`;
            html += `<div class="calendar-event-time">${timeStr}</div>`;
            html += `<div class="calendar-event-details">`;
            html += `<div class="calendar-event-title">${escapeHtml(e.title)}</div>`;
            html += `<div class="calendar-event-meta">${timeStr} – ${endStr}`;
            if (e.location) html += ` · ${escapeHtml(e.location)}`;
            html += `</div>`;
            if (e.meet_link) {
                html += `<a href="${escapeHtml(e.meet_link)}" target="_blank" rel="noopener" class="calendar-event-meet">Join Meet</a>`;
            }
            html += `</div></div>`;
        });
        div.innerHTML = html;
    } else if (data.success) {
        div.innerHTML =
            `<span class="label" style="color: #34d399;">📅 Calendar</span>` +
            `<div class="calendar-empty">No events found for this time period.</div>`;
    } else {
        div.innerHTML =
            `<span class="label" style="color: #34d399;">📅 Calendar</span>` +
            `<div class="zoom-error">Failed: ${escapeHtml(data.error || "Unknown error")}</div>`;
    }

    transcriptEl.appendChild(div);
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function addGoogleCalendarEventAdded(data) {
    const div = document.createElement("div");
    div.className = "msg calendar-added";

    if (data.success) {
        const start = new Date(data.start_time);
        const end = new Date(data.end_time);
        const dateStr = start.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
        const timeStr = start.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
        const endStr = end.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

        let html = `<span class="label" style="color: #34d399;">✅ Event Added</span>`;
        html += `<div class="zoom-topic">${escapeHtml(data.title)}</div>`;
        html += `<div style="font-size: 0.76rem; color: #6b7280;">${dateStr} · ${timeStr} – ${endStr}`;
        if (data.location) html += ` · ${escapeHtml(data.location)}`;
        html += `</div>`;
        div.innerHTML = html;
    } else if (data.conflict && data.conflicts) {
        let html = `<span class="label" style="color: #fbbf24;">⚠️ Scheduling Conflict</span>`;
        data.conflicts.forEach((c) => {
            const s = new Date(c.start).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
            const e = new Date(c.end).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
            html += `<div style="font-size: 0.82rem; margin: 4px 0; color: #d8dae5;">${escapeHtml(c.title)} <span style="color: #6b7280;">${s} – ${e}</span></div>`;
        });
        div.innerHTML = html;
        div.style.borderLeftColor = "#fbbf24";
    } else {
        div.innerHTML =
            `<span class="label" style="color: #34d399;">📅 Calendar</span>` +
            `<div class="zoom-error">Failed: ${escapeHtml(data.error || "Unknown error")}</div>`;
    }

    transcriptEl.appendChild(div);
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function addMeetingSummary(data) {
    const div = document.createElement("div");
    div.className = "msg search-results";
    div.style.borderLeftColor = "#34d399";

    let html = `<span class="label" style="color: #34d399;">📋 Meeting Summary</span>`;
    html += `<div style="font-size: 0.78rem; color: #6b7280; margin-bottom: 6px;">${escapeHtml(data.fileName)}</div>`;
    html += `<div style="white-space: pre-wrap; font-size: 0.85rem; line-height: 1.55;">${escapeHtml(data.summary)}</div>`;
    if (data.slack_posted) {
        html += `<div style="margin-top: 8px; font-size: 0.76rem; color: #34d399;">✅ Posted to Slack</div>`;
    }
    html += `<button class="download-summary-btn" style="margin-top: 10px; padding: 5px 14px; font-size: 0.8rem; border-radius: 20px; border: 1px solid #a78bfa; background: transparent; color: #a78bfa; cursor: pointer; transition: all 0.2s;">⬇ Download Notes</button>`;

    div.innerHTML = html;

    div.querySelector(".download-summary-btn").addEventListener("click", () => {
        const text = `${data.fileName}\n${"=".repeat(40)}\n\n${data.summary}`;
        const blob = new Blob([text], { type: "text/plain" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${data.fileName.replace(/[^a-z0-9]/gi, "_")}_summary.txt`;
        a.click();
        URL.revokeObjectURL(url);
    });

    transcriptEl.appendChild(div);
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

// ── Utilities ──

function float32ToInt16(float32Array) {
    const int16 = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i++) {
        const s = Math.max(-1, Math.min(1, float32Array[i]));
        int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return int16;
}

function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
}

function updateVisualizer(float32) {
    const step = Math.floor(float32.length / bars.length);
    for (let i = 0; i < bars.length; i++) {
        let sum = 0;
        for (let j = 0; j < step; j++) sum += Math.abs(float32[i * step + j]);
        const avg = sum / step;
        const height = Math.max(4, Math.min(40, avg * 300));
        bars[i].style.height = `${height}px`;
    }
}

function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
}

// ── Init ──

const enableBtn = document.getElementById("enable-btn");

enableBtn.addEventListener("click", async () => {
    // Request mic permission with a user gesture — this unlocks everything
    try {
        const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        // Got permission, release the temp stream
        tempStream.getTracks().forEach((t) => t.stop());

        // Hide enable button, show mic button
        enableBtn.style.display = "none";
        micBtn.style.display = "flex";

        // Now start wake word listening (mic permission already granted)
        initWakeWord();
        startWakeWordListening();
    } catch (err) {
        statusEl.textContent = `Mic permission denied: ${err.message}`;
    }
});
