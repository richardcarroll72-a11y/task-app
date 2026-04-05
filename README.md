# 📋 My Tasks — PWA Setup Guide

A clean, mobile-friendly Progressive Web App that surfaces your Notion To-Do tasks for the day. Mark tasks complete right from your phone and it syncs back to Notion instantly.

---

## What this app does

- Shows tasks from your Notion **🎒 To-Do** database that are due **today or overdue** and not yet Done
- Stats bar shows count of today's tasks and overdue tasks
- Tap the circle to **mark any task complete** → sets Status = Done and Date Completed = today in Notion
- **+ button** to add new tasks directly to your Notion database
- Works offline (shows cached tasks)
- Installable as a home screen app on iPhone and Android

---

## Step 1 — Get your Notion credentials

### Notion Integration Token
1. Go to [https://www.notion.so/my-integrations](https://www.notion.so/my-integrations)
2. Click **+ New integration**
3. Name it "My Tasks App", select your workspace, click Submit
4. Copy the **Internal Integration Token** (starts with `secret_...`)
5. **Important:** Go to your To-Do database in Notion → click the `...` menu (top right) → **Connections** → Add your new integration

### Notion Database ID
Your To-Do database ID is already known:
```
64204e6b365f836c83798111f9c55f5a
```
You can confirm this from the database URL: `https://www.notion.so/64204e6b365f836c83798111f9c55f5a`

---

## Step 2 — Deploy to Vercel (free)

### Option A: Deploy via GitHub (recommended)

1. Create a free account at [vercel.com](https://vercel.com) (sign in with GitHub)
2. Push this entire `task-app/` folder to a GitHub repository
3. In Vercel: click **Add New Project** → Import your GitHub repo
4. Vercel will auto-detect the `vercel.json` config
5. Before deploying, add **Environment Variables**:
   - `NOTION_TOKEN` → your integration token from Step 1
   - `NOTION_DATABASE_ID` → `64204e6b365f836c83798111f9c55f5a`
6. Click **Deploy**
7. Your app will be live at `https://your-project-name.vercel.app`

### Option B: Deploy via Vercel CLI

```bash
# Install Vercel CLI
npm install -g vercel

# Navigate to the task-app folder
cd task-app

# Deploy (follow the prompts)
vercel

# Set environment variables
vercel env add NOTION_TOKEN
vercel env add NOTION_DATABASE_ID

# Redeploy with env vars
vercel --prod
```

---

## Step 3 — Add to iPhone Home Screen

1. Open your Vercel URL in **Safari** on your iPhone
2. Tap the **Share** button (box with arrow pointing up)
3. Scroll down and tap **"Add to Home Screen"**
4. Tap **Add**

The app will appear on your home screen with the ✅ icon and "My Tasks" label. It opens full-screen with no browser chrome, just like a native app.

---

## File structure

```
task-app/
├── index.html          Main PWA (single file, all CSS + JS embedded)
├── manifest.json       PWA manifest (enables "Add to Home Screen")
├── sw.js               Service worker (offline support)
├── vercel.json         Vercel routing config
├── api/
│   └── tasks.js        Serverless function — proxies Notion API
└── README.md           This file
```

---

## API endpoints (handled by api/tasks.js)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/tasks` | Fetch today's + overdue tasks (Status ≠ Done, Due Date ≤ today) |
| `POST` | `/api/tasks` | Create a new task in Notion |
| `PATCH` | `/api/tasks?id={page_id}` | Mark a task complete (Status = Done, Date Completed = today) |

---

## Notion database properties used

| Property | Type | Used for |
|----------|------|---------|
| `Name` | Title | Task name |
| `Status 1` | Status | Task status (Not started / In progress / Done) |
| `Due Date` | Date | When the task is due |
| `Priority` | Select | High 🔥 / Medium / Low |
| `Project` | Multi-select | Personal / Work / Health / Finance |
| `Notes` | Text | Optional task notes |
| `Date Completed` | Date | Set automatically when marked Done |

---

## Troubleshooting

**Tasks not loading?**
- Check that your Notion integration has access to the database (Settings → Connections)
- Verify `NOTION_TOKEN` and `NOTION_DATABASE_ID` are set in Vercel Environment Variables
- Check the Vercel function logs: go to your project → Functions tab

**"Could not mark task complete" error?**
- Same as above — check Notion integration permissions
- Make sure the Status 1 property has a "Done" option

**App not installing on iPhone?**
- Must use **Safari** (not Chrome) on iOS to get "Add to Home Screen"
- The URL must be HTTPS (Vercel provides this automatically)

---

## Customisation

- **Change the accent colour:** Edit `--primary: #6366f1` in the CSS
- **Add more project categories:** Update `api/tasks.js` and the checkboxes in `index.html`
- **Change which tasks show:** Edit the `filter` in `api/tasks.js` `GET` handler
- **Notion dashboard:** https://www.notion.so/33904e6b365f81cea74ec7ec80c7978a

---

Built for Richard · richardcarroll72@gmail.com · April 2026
