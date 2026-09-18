# Pushing AgentFund to GitHub and deploying on Render

Follow these steps in order. Your API key never gets committed.

---

## Part 1 — Create the repo and push

### 1. Check what will be committed

From the project folder:

```bash
cd /Users/user/agentfund
git status
```

You should see these as **untracked** files:

```
.env.example
.gitignore
README.md
DEPLOY.md
index.html
package.json
render.yaml
server.js
styles.css
js/
```

### 2. Confirm `.env` is ignored

This is the important check. Run:

```bash
git check-ignore -v .env
```

Expected output — something like:

```
.gitignore:2:.env	.env
```

If this prints **nothing**, `.env` is NOT ignored. Stop and fix `.gitignore` before
continuing, otherwise your API key will be published.

You can also verify the key is not staged anywhere:

```bash
grep -r "sk-" . --exclude-dir=.git --exclude=.env
```

This should return no results.

### 3. Initialise and commit

```bash
git init
git add .
git status          # review the list one more time
```

Make sure `.env` is **not** in the staged list. Then:

```bash
git commit -m "Initial commit: AgentFund task planner"
```

### 4. Create the repo on GitHub

1. Go to https://github.com/new
2. Name it (e.g. `agentfund`)
3. Leave it **completely empty** — do NOT add a README, `.gitignore`, or license
4. Click **Create repository**

### 5. Push

GitHub will show you the commands. They look like this (replace `YOUR_USERNAME`
and `agentfund` with your actual values):

```bash
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/agentfund.git
git push -u origin main
```

If prompted to sign in, use a **personal access token** as the password (GitHub
no longer accepts account passwords over HTTPS).

### 6. Verify on GitHub

Open the repo in your browser and confirm:

- `.env` is **not** listed
- `.env.example` **is** listed
- `index.html`, `server.js`, `styles.css`, `js/`, `render.yaml`, `package.json` are present

Open `.env.example` on GitHub and confirm it contains **empty** values, not your key.

---

## Part 2 — Deploy on Render

### 1. Create the service

1. Go to https://dashboard.render.com
2. **New → Blueprint**
3. Connect your GitHub account if prompted, then select the `agentfund` repo
4. Render reads `render.yaml` and pre-fills the service

### 2. Enter your three values

Render will prompt for these because `render.yaml` marks them `sync: false`:

| Variable | Value |
|---|---|
| `AGENTFUND_BASE_URL` | `https://api.orbio.so/api/v1` |
| `AGENTFUND_API_KEY` | your key (the value in your local `.env`) |
| `AGENTFUND_MODEL` | `tencent/hy4-preview` |

These are stored encrypted in Render. They are not in your repo.

### 3. Deploy

Click **Apply**. Render will:

- run `npm install` (no dependencies, so it's instant)
- start with `npm start`
- health-check `/api/health`

### 4. Verify

Once live, open:

```
https://your-service.onrender.com/api/health
```

You want:

```json
{"ok":true,"online":true,"provider":"estimation"}
```

If `online` is `false`, the environment variables did not apply — re-check the
Environment tab in Render.

---

## Part 3 — After deploy

### Test the full flow

Open your Render URL, type a task, pick a budget, and click **Analyze Task**.

Note that `tencent/hy4-preview` is a **reasoning model** — it thinks before it
answers, so an analysis takes roughly 1–3 minutes. Add a task, and it will seem
slow but is working. The button shows "Analyzing..." while it runs.

### If analysis fails

The app falls back to the built-in local estimator automatically and shows a
"Estimated locally" notice, so the app keeps working. If you want to diagnose:

- Render dashboard → your service → **Logs**
- Confirm `/api/health` shows `"provider":"estimation"`

### Redeploying after changes

```bash
git add .
git commit -m "describe your change"
git push
```

Render redeploys automatically on every push to `main`.

---

## Security notes

- `.env` is gitignored and stays on your machine.
- Never commit a real key. If you ever do, **revoke it immediately** at your
  provider and generate a new one — deleting the commit is not enough, since
  git history and GitHub caches keep it.
- To rotate your key: generate a new one, update it in Render's Environment tab,
  and update your local `.env`.
- `.env.example` is committed on purpose: it documents which variables exist
  without containing any real values.