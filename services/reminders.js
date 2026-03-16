const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { WebSocket } = require("ws");

const REMINDERS_PATH = path.join(__dirname, "..", "reminders.json");
const activeTimers = new Map();
let activeClients = null; // set from server.js

function setActiveClients(clients) {
    activeClients = clients;
}

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

function restoreReminders() {
    const reminders = loadReminders();
    const now = Date.now();
    const pending = [];
    for (const r of reminders) {
        if (new Date(r.fireAt).getTime() > now) {
            scheduleReminder(r);
            pending.push(r);
        }
    }
    saveReminders(pending);
    if (pending.length > 0) {
        console.log(`Restored ${pending.length} pending reminder(s)`);
    }
}

module.exports = { addReminder, restoreReminders, setActiveClients };
