# catsof.dev

Minimal Eleventy scaffold for a site like dogsof.dev, but for cats of developers.

## Quick start

```bash
npm install
cp .env.example .env
npm run dev
```

Use `npm run dev` and open `http://localhost:8888`.
`http://localhost:8080` is the raw Eleventy server and `/api/submit` will 404 there.

If you only want a static preview (no form submission), run:

```bash
npm run dev:site
```

## Airtable setup

1. Create a new Airtable base.
2. Create a table (or use any name and set `AIRTABLE_TABLE_NAME`).
3. Add these fields (exact names):
   - `Cat Name` (single line text)
   - `Human Name` (single line text)
   - `Developer URL` (url)
   - `Photo URL` (url)
   - `Story` (long text)
   - `Status` (single select)
4. Create a view, filtered to `Status`.
5. Create a Personal Access Token in Airtable:
   - Scopes: `data.records:read`, `data.records:write`
   - Base access: your new base
6. Set environment variables in local `.env` and in Netlify:
   - `AIRTABLE_TOKEN`
   - `AIRTABLE_BASE_ID`
   - `AIRTABLE_TABLE_NAME`
   - `AIRTABLE_VIEW`

## Cloudinary setup

1. Create a Cloudinary account and copy these values from your dashboard/API settings:
   - `CLOUDINARY_CLOUD_NAME`
   - `CLOUDINARY_API_KEY`
   - `CLOUDINARY_API_SECRET`
2. Set these environment variables in local `.env` and in Netlify:
   - `CLOUDINARY_CLOUD_NAME`
   - `CLOUDINARY_API_KEY`
   - `CLOUDINARY_API_SECRET`
   - `CLOUDINARY_FOLDER`

## How it works

- Homepage reads approved records from Airtable at build time (`src/_data/cats.js`).
- `/submit/` posts to `/api/submit`.
- Netlify redirects `/api/submit` to `netlify/functions/submit-cat.js`.
- Submit accepts either a direct file upload (`photoFile`) or an external URL (`photoUrl`).
- The function validates the input image, uploads it to Cloudinary, and stores only the Cloudinary `secure_url` in Airtable (`Photo URL`).
- Function writes submissions as `Status = Pending`.
- After you mark a record as `Approved`, rebuild/redeploy and it appears on `/`.

## Troubleshooting

- `Airtable read failed: NOT_FOUND`:
  - `AIRTABLE_BASE_ID` is wrong, or
  - `AIRTABLE_TABLE_NAME` does not exactly match table name, or
  - your Airtable token does not have access to that base.
- `Could not save submission ...`:
  - same checks as above, plus verify the required fields exist with exact names.
- `Missing Cloudinary configuration.`:
  - set `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, and `CLOUDINARY_API_SECRET` in both local and Netlify env.
- `Image upload to Cloudinary failed.`:
  - verify Cloudinary credentials and that the account can accept uploads.
