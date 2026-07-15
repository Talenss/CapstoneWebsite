# ResumeMatch PH — Setup Guide

Everything you need to get the site running on your own laptop and, later, on a real host. Written for someone who has **not** set up a PHP server before. Follow it top to bottom.

There are two modes:

- **Demo mode** — the site runs with *zero setup*, straight from the files, storing data in your browser. This is what you use to click around, screenshot, and rehearse the defense. It's already on.
- **Server mode** — the real thing: PHP + a MySQL database. Use this when you want data to persist properly, support multiple real users, and match what the paper describes. Setup is below.

You only need server mode when you're ready for it. Demo mode is enough to *show* the whole system working.

---

## Part 1 — Run it right now (demo mode, no setup)

1. Open the `04_Website/app` folder.
2. Double-click `index.html`. It opens in your browser. **Done.**

Log in with any of these (password for all is `demo123`):

| Role | Email |
|------|-------|
| Job seeker | `seeker@demo.ph` |
| Royce HR (recruiter) | `hr@demo.ph` |
| More applicants | `ana@demo.ph`, `marco@demo.ph`, `liza@demo.ph` |

Everything works: build a resume, get scored, apply, and log in as HR to see the ranked applicants. Data is saved in *that browser* only. To wipe it and start fresh, open the browser console (F12) and run `RMPH.resetDemo()`, then refresh.

> **Tip for the defense:** demo mode needs no internet and no server. If the venue Wi‑Fi dies, demo mode still works — *except* the fonts, which load from the internet. See **Part 4** to make fonts work offline too.

---

## Part 2 — Run it for real (server mode with XAMPP)

This gets you a proper PHP + MySQL setup on your own computer.

### Step 1 — Install XAMPP

1. Download XAMPP from <https://www.apachefriends.org> (get the version with **PHP 8.1 or newer**).
2. Install it. On Windows the default location is `C:\xampp`.
3. Open the **XAMPP Control Panel** and click **Start** next to both **Apache** and **MySQL**. Both should turn green.

### Step 2 — Put the project where the server can see it

Copy the whole `04_Website` folder into XAMPP's web root:

- **Windows:** `C:\xampp\htdocs\` → so you end up with `C:\xampp\htdocs\04_Website`
- **macOS:** `/Applications/XAMPP/htdocs/`
- **Linux:** `/opt/lampp/htdocs/`

### Step 3 — Create the database

1. In your browser go to <http://localhost/phpmyadmin>.
2. Click the **SQL** tab at the top.
3. Open `04_Website/db/schema.sql` in a text editor, copy **everything**, paste it into the SQL box, and click **Go**. This creates the `resumematch_ph` database and all its tables.
4. Click the **SQL** tab again. Open `04_Website/db/seed.sql`, copy everything, paste, and click **Go**. This loads Royce Hotel & Casino, the demo accounts, and the sample openings and applicants.

> The demo accounts and password (`demo123`) are the same as in demo mode — the seed file already contains a working encrypted password, so there's nothing to fill in.

### Step 4 — Flip the switch to server mode

1. Open `04_Website/app/assets/api.js` in a text editor.
2. At the very top, find:
   ```js
   const CONFIG = {
     mode: 'demo',        // <-- flip to 'php' after following SETUP.md
   ```
3. Change `'demo'` to `'php'`:
   ```js
     mode: 'php',
   ```
4. Save.

### Step 5 — Open the real site

Go to <http://localhost/04_Website/app/index.html>.

That's the live version, talking to MySQL. Log in with the same demo accounts. Create a new job seeker account and it's now a real row in the database — check phpMyAdmin and you'll see it.

**If you used the default XAMPP setup, you're done.** The database settings in `04_Website/api/config.php` already match XAMPP's defaults (user `root`, empty password).

---

## Part 3 — If something doesn't work

**"Can't reach the server" message in the site.**
Apache isn't running, or you opened the file directly instead of through `localhost`. Make sure the URL starts with `http://localhost/…`, not `file://…`, and that Apache is green in the XAMPP panel.

**"Database connection failed."**
MySQL isn't running (start it in XAMPP), or your MySQL credentials differ from the defaults. If you set a MySQL root password, open `04_Website/api/config.php` and put it in `DB_PASS`.

**A blank page, or a page that half-loads.**
Your PHP version is probably older than 8.1. Update XAMPP. To check your version, make a file in `htdocs` containing `<?php phpinfo();` and open it via `localhost`.

**Uploaded resume files don't appear for HR.**
The `04_Website/api/uploads` folder must be writable. On Windows it usually is by default. On macOS/Linux run `chmod 755 04_Website/api/uploads` in a terminal.

**I want to start the database over.**
In phpMyAdmin, drop the `resumematch_ph` database, then re-run Step 3.

---

## Part 4 — Make fonts work offline (optional but recommended for the defense)

The site's two fonts (Cormorant Garamond and Inter) normally load from Google. Without internet they fall back to built-in fonts — it still looks clean, but not identical. To lock the real fonts in so they work with no internet at all:

1. On a computer *with* internet, go to <https://gwfh.mranftl.com/fonts>.
2. Search **Cormorant Garamond**, tick weights 500/600/700, and download the **woff2** files. Do the same for **Inter** (weights 400/500/600/700).
3. Put the downloaded `.woff2` files in `04_Website/app/assets/fonts/`.
4. Open `04_Website/app/assets/fonts.css`, follow the short instructions at the top (rename the files to match, uncomment the block), and add one line to each page's `<head>`:
   ```html
   <link rel="stylesheet" href="assets/fonts.css">
   ```

Full instructions are inside `fonts.css`. This is optional — skip it if you'll have Wi‑Fi.

---

## Part 5 — Putting it on the internet later (hosting)

When you're ready to host it so others can reach it, you need a host that runs **PHP 8.1+ and MySQL**. Shared hosting is fine and cheap; you do **not** need anything fancy.

The short version of what you'll do:

1. Pick a host that supports PHP + MySQL (e.g. Hostinger, InfinityFree for a free option, or any cPanel host). Avoid "static only" hosts like GitHub Pages — they can't run PHP.
2. In the host's control panel, create a MySQL database and a database user. It will give you four things: **host, database name, username, password**.
3. Put those four values into `04_Website/api/config.php` (`DB_HOST`, `DB_NAME`, `DB_USER`, `DB_PASS`).
4. Upload the contents of `04_Website` to the host (via their file manager or FTP).
5. Import `db/schema.sql` then `db/seed.sql` through the host's phpMyAdmin, exactly like Step 3.
6. Make sure `api.js` has `mode: 'php'`.
7. Set `DEBUG` to `false` in `config.php` so error details aren't shown to visitors.

When you get there, tell me your host and I'll give you the exact click-by-click for that provider.

### One security note for real hosting
The `api/uploads` folder holds applicants' resume files and must **not** be publicly browsable. This project already protects it two ways — the files are served only through `api/file.php` after an access check, and there's an `.htaccess` that blocks direct access. On Apache hosts this just works. If your host uses **Nginx** instead, tell me and I'll give you the equivalent rule.

---

## What's where

```
04_Website/
├── app/                      the website (this is what people open)
│   ├── index.html            landing page
│   ├── auth.html             log in / register / request recruiter access
│   ├── seeker-dashboard.html job seeker home — matches in 3 tiers
│   ├── browse.html           all openings, scored
│   ├── resume-builder.html   the guided builder + live preview + uploads
│   ├── my-resumes.html       manage saved resumes
│   ├── resume-print.html     ATS-friendly PDF/print view
│   ├── hr-dashboard.html     recruiter home — pipeline & openings
│   ├── hr-applicants.html    ranked applicants + dual-resume view
│   ├── hr-posting.html       create/edit an opening
│   ├── hr-company.html       company profile
│   ├── account.html          password + download/delete my data (RA 10173)
│   ├── learning-hub.html     resume & ATS guides
│   ├── privacy.html          privacy notice
│   ├── 404.html
│   └── assets/
│       ├── styles.css        the whole design system
│       ├── api.js            the ONE file with the mode switch (demo/php)
│       ├── tutorial.js       the onboarding tour engine
│       ├── fonts.css         optional offline fonts
│       └── favicon.svg
├── api/                      the PHP backend (used only in server mode)
│   ├── config.php            database settings — edit this per machine
│   ├── _lib.php              shared code + the matching engine
│   ├── auth.php  companies.php  resumes.php  postings.php
│   ├── applications.php  match.php  stats.php  file.php
│   └── uploads/              applicants' uploaded files (kept private)
└── db/
    ├── schema.sql            creates the database and tables
    └── seed.sql              loads Royce + demo data
```

The single most important thing to remember: **`app/assets/api.js`, line ~30, is the switch.** `'demo'` = browser-only, no setup. `'php'` = the real database. Nothing else changes between the two.
