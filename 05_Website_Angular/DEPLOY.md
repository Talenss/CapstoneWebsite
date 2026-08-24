# Putting the site online with Vercel

This is the short version, written for someone who has never deployed a
website before. You do not need to understand the code to follow it.

---

## The one thing to understand first

Vercel serves **files**. It does not run our Node/Express server.

So what goes online is the **demo build** — the version that runs entirely
inside the visitor's browser and stores its data in that browser. It needs
no API and no database, which is exactly why it can live on a host like
this.

| Build | Command | Works on Vercel? |
|---|---|---|
| Demo (browser-only) | `npm run build:demo` | **Yes.** This is what we deploy. |
| Full (API + database) | `npm run build` | No. It would upload fine, then every `/api` call would return 404 — login would fail and the site would look broken. |

Putting the **full** system online is a separate job: the Express server
has to run somewhere that executes Node (Render, Railway, Fly.io), pointed
at the Supabase database, and the client has to be built to talk to it.
See `SETUP.md`.

> If a panelist asks whether the live link is the real system: it is the
> demonstration build, on seeded sample data, and it contains no real
> applicant information. Say so plainly — it is in the Reviewer notes too.

---

## Setting it up (about five minutes)

1. Go to <https://vercel.com> and sign in with GitHub.
2. **Add New → Project**, then pick this repository.
3. On the import screen, find **Root Directory** and press **Edit**.
   Choose:

   ```
   05_Website_Angular/client
   ```

   This is the single most important setting. The repository has several
   folders, and this tells Vercel which one is the website.
4. Leave everything else alone. Framework, build command and output
   directory are already written down in `client/vercel.json`, so Vercel
   fills them in by itself.
5. Press **Deploy**.

That is it. Every push to the branch afterwards redeploys automatically,
and every pull request gets its own preview link.

---

## The one optional setting

If you want a `sitemap.xml` (helps Google find the pages), add an
environment variable in **Project Settings → Environment Variables**:

| Name | Value |
|---|---|
| `SITE_URL` | your final address, e.g. `https://resumematch-ph.vercel.app` |

Without it no sitemap is written, **on purpose** — a sitemap listing URLs
on the wrong domain is worse than having none, because every link in it
would 404. The site works perfectly well without one.

---

## What is in `client/vercel.json`, in plain words

- **Build command** — run the demo build.
- **Output directory** — where the finished files land (`dist/client/browser`).
- **Rewrite** — send every unknown address to `index.html`. Angular decides
  the page in the browser, so `/browse` is not a file on disk. Without this
  rule, every link typed directly and every page refresh returns 404.
- **Security headers** — a Content-Security-Policy plus three smaller
  protections. In full mode the Express server sends these itself; a static
  host does not, so they are declared here or the deployed site would have
  none.
- **Caching** — the `.js` and `.css` files have a content hash in their
  names, so they can be cached forever safely. `index.html` deliberately is
  not cached, or returning visitors would keep getting the old app.

---

## Note for the record

This project was previously configured for Netlify. `netlify.toml` and
`client/public/_redirects` were removed when it moved to Vercel; both are
still in the git history if they are ever needed again
(`git log --diff-filter=D -- netlify.toml`).
