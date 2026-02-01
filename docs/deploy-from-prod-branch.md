# Explicit deploys via prod branch

Deploys are **explicit**: production only updates when you merge into `prod` and push. Pushing to `main` does **not** deploy.

## Branch roles

| Branch | Role | Push = deploy? |
|--------|------|----------------|
| `main` | Development. All work and PRs go here. | No |
| `prod` | Production. Railway deploys from this branch. | Yes |

## One-time setup

1. **Create and push the prod branch** (if not already):
   ```bash
   git checkout main
   git pull
   git branch prod
   git push -u origin prod
   ```

2. **Configure Railway** to deploy from `prod`:
   - Railway dashboard → your **project** → open each **service** (web, daemon, etc.) → **Settings**.
   - Find **Source** or **Repository** / **Connected repo**.
   - Look for **Branch** or **Trigger branch** (dropdown). Choose `prod`.
   - If `prod` doesn’t appear: **Disconnect** the repo, then **Connect** again so Railway refetches branches. Then pick `prod`.
   - Save. Railway will deploy when `prod` is updated.

## Deploying

When you want to ship what’s on `main` to production, **you** run (the agent must never merge or push to prod):

```bash
git checkout prod
git pull origin prod
git merge main -m "Deploy: <short description>"
git push origin prod
git checkout main
```

Railway will build and deploy from the new `prod` tip.

## Troubleshooting: "Can't set prod"

- **Branch list doesn’t show prod**  
  Make sure `prod` exists on GitHub: `git push -u origin prod`. Then in Railway: **Disconnect** the GitHub repo from the service, then **Connect** again and pick the same repo — the branch dropdown should refresh and include `prod`.

- **No branch dropdown**  
  The branch selector only appears when the service is connected to a **GitHub repo** (not a template or public URL). If you deployed from a template, connect the service to your GitHub repo in Settings → Source, then set the branch.

- **Still stuck**  
  Railway docs: [Controlling GitHub Autodeploys](https://docs.railway.com/guides/github-autodeploys). Or ask in [Railway Discord](https://discord.gg/railway) / support.

## Summary

- Work and push freely on `main` (no production deploy).
- Deploy only when you merge `main` into `prod` and push `prod`.
