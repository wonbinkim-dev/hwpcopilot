// All rectangles here use Electron device-independent pixels (DIP).
export function panelBounds(target, workArea, width = 400) {
  const w = Math.min(Math.max(320, width), workArea.width);
  const height = Math.min(Math.max(420, target.height), workArea.height);
  const right = workArea.x + workArea.width;
  let x = target.x + target.width + 6;
  if (x + w > right) {
    x = target.x - w - 6;
    if (x < workArea.x) x = target.x + target.width - w;
  }
  return { x: Math.round(Math.min(Math.max(x, workArea.x), right - w)), y: Math.round(Math.min(Math.max(target.y, workArea.y), workArea.y + workArea.height - height)), width: Math.round(w), height: Math.round(height) };
}

export function shouldShowPanel(frame, panelFocused) {
  return Boolean(frame.exists && frame.visible && !frame.minimized && (frame.foreground || panelFocused));
}
