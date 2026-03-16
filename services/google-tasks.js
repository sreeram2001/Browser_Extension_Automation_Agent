const { google } = require("googleapis");
const { getGoogleAuth } = require("./google-auth");

async function createGoogleTasks({ tasks, task_list }) {
    const auth = getGoogleAuth();
    const tasksApi = google.tasks({ version: "v1", auth });

    try {
        let taskListId = "@default";
        if (task_list) {
            const lists = await tasksApi.tasklists.list({ maxResults: 20 });
            const match = (lists.data.items || []).find(
                (l) => l.title.toLowerCase() === task_list.toLowerCase()
            );
            if (match) {
                taskListId = match.id;
            } else {
                const newList = await tasksApi.tasklists.insert({
                    requestBody: { title: task_list },
                });
                taskListId = newList.data.id;
            }
        }

        const created = [];
        for (const t of tasks) {
            const taskBody = { title: t.title };
            if (t.notes) taskBody.notes = t.notes;
            if (t.due) taskBody.due = new Date(t.due).toISOString();

            const res = await tasksApi.tasks.insert({
                tasklist: taskListId,
                requestBody: taskBody,
            });

            created.push({
                id: res.data.id,
                title: res.data.title,
                due: res.data.due || null,
            });
        }

        return { success: true, created, total: created.length };
    } catch (err) {
        console.error("Google Tasks error:", err.message);
        return { success: false, error: err.message, created: [] };
    }
}

module.exports = { createGoogleTasks };
