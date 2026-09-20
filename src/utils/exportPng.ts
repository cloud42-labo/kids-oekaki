import type { DrawingDocument } from '../domain/drawing';
import { renderDocument } from '../engine/renderer';

export async function exportPng(document: DrawingDocument) {
  const canvas = window.document.createElement('canvas');
  canvas.width = document.width;
  canvas.height = document.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context is unavailable');
  renderDocument(ctx, document);

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((result) => result ? resolve(result) : reject(new Error('PNG export failed')), 'image/png');
  });

  const url = URL.createObjectURL(blob);
  const link = window.document.createElement('a');
  link.href = url;
  link.download = `oekaki-${new Date().toISOString().slice(0, 10)}.png`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
