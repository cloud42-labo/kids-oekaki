# PoC analysis: oekaki_v2.html

## What already works well
- Tablet-oriented viewport and scroll/zoom suppression.
- Three starting formats: blank, 4-panel manga, picture diary.
- Layered canvas stack with background, sketch, coloring, and line art.
- Pen, semi-transparent marker, eraser, 10-color palette, custom color picker, 1–60 brush size.
- Pointer Events input and PNG export.

## Productization constraints found
1. Drawing state is pixels on Canvas only. Undo/Redo, editable stamps, and robust dynamic layers become expensive if retained as pixel snapshots.
2. Layers are fixed DOM canvases and fixed toolbar buttons; add/remove/reorder requires structural rewrite.
3. A single top canvas captures all input and drawing is redirected into selected lower canvases. This works for the PoC but couples event routing to a specific layer arrangement.
4. Layout scale is calculated at start-up only; resize/orientation change is not modeled.
5. `toDataURL()` creates a large in-memory string; `toBlob()` is preferable for tablet memory use.
6. `pointercancel`, coalesced pointer samples, pen/touch distinction, and a palm-rejection policy are not covered.
7. Background template rendering and drawing logic live in one script, so future brushes/stamps would increase coupling.

## Migration decision
Move to a document model where Stroke and Stamp objects are data. Canvas 2D becomes a renderer, not the source of truth. This makes Undo/Redo a document-history operation and makes magic brushes/stamps/layers straightforward extensions.
