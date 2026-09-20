# Architecture

## Decision
PWA-first: React + TypeScript + Vite + Canvas 2D.

Do not start with Kotlin native. The first target is Android/Kindle tablets and the core feature is local drawing, so one Web codebase gives the fastest validation path. If device testing finds browser-level input/palm-rejection/file-save limitations, add a Capacitor Android shell without rewriting the drawing domain or renderer.

## Layers
- `domain/`: DrawingDocument, Layer, Stroke, Stamp, Template types.
- `state/`: immutable document history and Undo/Redo.
- `engine/`: pure Canvas 2D rendering from document data.
- `components/`: child-oriented UI and pointer input.
- `utils/`: PNG export and later persistence/share adapters.

## Drawing document
The document is the source of truth. Each layer owns a list of objects. An eraser is stored as a layer-local stroke rendered with `destination-out` on an off-screen layer surface. Layers are then composited in order.

Benefits:
- Undo/Redo does not require full bitmap snapshots per action.
- Layer add/remove/visibility is natural state editing.
- Magic brushes can become new stroke renderers.
- Stamps are persistent editable objects rather than flattened pixels.
- Export is a deterministic rasterization of the document.

## Input policy
- Pointer Events for pen/touch/mouse.
- Use coalesced events when available for smoother strokes.
- Ignore non-primary touch pointers.
- Ignore touch briefly after pen input as a Web palm-rejection heuristic.
- If Kindle/Android device validation proves insufficient, add native input handling through Capacitor/Android without changing document APIs.

## PWA
The initial service worker uses network-first runtime caching and provides an app manifest. Production hardening should add versioned precache generation and install/update UX after the basic tablet E2E test passes.
