# Logo Remover — Next.js

Remove logos and watermarks from images using click-to-select or brush painting, powered by [LaMa inpaint](https://sanster-iopaint-lama.hf.space).

## Stack

- **Next.js 15** (App Router)
- **React 19** + TypeScript
- **Tailwind CSS**
- **Sharp** (server-side image processing)
- **API Routes** (`/api/health`, `/api/inpaint`)

## Features

- Upload image (drag & drop)
- **Select box** — drag a rectangle around the logo
- **Brush** — paint over the watermark
- Before/after comparison + PNG download
- LaMa AI inpainting via Hugging Face Space API

## Quick start

```bash
npm install
npm run dev
```

Open **http://localhost:3000**

## Production

```bash
npm run build
npm start
```

## Environment

| Variable | Default |
|----------|---------|
| `INPAINT_API_URL` | `https://sanster-iopaint-lama.hf.space/api/v1/inpaint` |

## Project structure

```
app/
  api/health/route.ts    # Health check
  api/inpaint/route.ts   # Logo removal API
  layout.tsx
  page.tsx
components/
  LogoRemoverApp.tsx     # Main UI
  ImageEditor.tsx        # Mask canvas + tools
lib/
  inpaint.ts             # Server inpaint logic
  maskGeometry.ts        # Selection math
types/
  index.ts
```
