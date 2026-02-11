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
2. Create a table for submissions.
3. Add fields for cat details, owner details, image URL, story text, and moderation status.
4. Create an approved-only view for published entries.
5. Create a Personal Access Token in Airtable:
   - Grant read/write access to records in your base.
6. Set the required Airtable credentials/configuration in local environment and in Netlify.

## Cloudinary setup

1. Create a Cloudinary account and collect the required API credentials.
2. Set the required Cloudinary credentials/configuration in local environment and in Netlify.

## How it works

- Homepage reads approved records from Airtable at build time (`src/_data/cats.js`).
- `/submit/` posts to `/api/submit`.
- Netlify redirects `/api/submit` to `netlify/functions/submit-cat.js`.
- Submit accepts either a direct file upload or an external URL.
- The function validates the input image, uploads it to Cloudinary, and stores the hosted URL in Airtable.
- Function writes submissions as pending first.
- After you approve a record, rebuild/redeploy and it appears on `/`.

## Troubleshooting

- If Airtable read/write fails:
  - verify table/view setup, field names, and token permissions.
- If Cloudinary upload fails:
  - verify API credentials and account permissions.
