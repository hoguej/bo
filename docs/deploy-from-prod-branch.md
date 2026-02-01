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
   - Railway dashboard → your project → **Settings** (or each service → Settings).
   - Under **Source** / **Build**, set **Branch** to `prod` (instead of `main`).
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

## Summary

- Work and push freely on `main` (no production deploy).
- Deploy only when you merge `main` into `prod` and push `prod`.
