# Local wiki (not in Git)

The folder **`wiki/`** at the repository root is listed in **`.gitignore`**. It is **never committed or pushed** to GitHub.

## First-time setup

Copy the starter pages into your private wiki:

```bash
cd /path/to/apix-g
cp -r docs/wiki-template/. wiki/
```

Or on Windows (PowerShell):

```powershell
Copy-Item -Recurse docs/wiki-template/* wiki/
```

Then edit files under `wiki/` as you like. They stay local unless you remove the `wiki/` line from `.gitignore` (not recommended for private notes).

## Optional: GitHub wiki

If you want a **public** wiki on GitHub, use the separate **Wiki** tab on the repo and maintain it there; keep private or draft material only under `wiki/`.
