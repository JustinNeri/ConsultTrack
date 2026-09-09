# Static assets

Files in this folder are served from the site root as-is by Vite, and are copied
into `dist/` on build. A file here named `foo.jpg` is reachable at `/foo.jpg`.

## campus.jpg — the sign-in backdrop

Drop the campus photograph here as **`campus.jpg`** (this exact name; the path is
referenced by `AUTH_BACKDROP` in `src/components/AuthScreen.jsx`).

- Landscape or portrait both work — it is rendered `bg-cover bg-center`.
- Aim for ~1920px on the long edge and under ~400KB. JPEG or WebP (rename the
  constant if you use `.webp`).
- Composition matters: the top half of the image is covered by a near-opaque
  maroon wash, so put the recognisable part of the building low in the frame.

Until the file exists the sign-in screen falls back to flat maroon — nothing
breaks, it just loses the photograph.
