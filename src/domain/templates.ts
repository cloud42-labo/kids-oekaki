import type { TemplateKind } from './drawing';

export function drawTemplate(
  ctx: CanvasRenderingContext2D,
  template: TemplateKind,
  width: number,
  height: number,
) {
  ctx.save();
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = '#2a2530';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (template === '4koma') {
    const margin = 50;
    const boxHeight = (height - margin * 5) / 4;
    ctx.lineWidth = 4;
    for (let i = 0; i < 4; i += 1) {
      ctx.strokeRect(margin, margin + (boxHeight + margin) * i, width - margin * 2, boxHeight);
    }
  }

  if (template === 'diary') {
    const margin = 50;
    const pictureHeight = height * 0.5;
    ctx.lineWidth = 4;
    ctx.strokeRect(margin, margin, width - margin * 2, pictureHeight);
    ctx.lineWidth = 2;
    for (let y = margin + pictureHeight + 50; y < height - margin; y += 60) {
      ctx.beginPath();
      ctx.moveTo(margin, y);
      ctx.lineTo(width - margin, y);
      ctx.stroke();
    }
  }

  ctx.restore();
}
