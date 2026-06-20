# Logo Remover — Click to Inpaint

React + Express app that removes logos/watermarks from images using click-to-mask and the [LaMa inpaint API](https://sanster-iopaint-lama.hf.space).

## Features

- Upload image (drag & drop or click)
- **Click on the logo** to place the removal mask
- Adjustable mask width, height, and feather blur
- Bottom-right auto mode (matches your batch script)
- Before/after comparison and PNG download
- Express proxy avoids CORS issues with the Hugging Face Space API

## Quick start

```bash
npm install
npm install --prefix server
npm install --prefix client
npm run dev
```

Open **http://localhost:5173**

## Production

```bash
npm run build
npm start
```

## Stack

- **Frontend:** React 19, Vite, Tailwind CSS, TypeScript
- **Backend:** Express, Sharp, Multer
