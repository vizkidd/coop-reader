import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScript } from './helpers/load.mjs';
const { CoopInput: I } = loadScript('coop-input.js');

test('zoom is clamped to the supported range and survives garbage input', () => {
  assert.equal(I.clampZoom(0.01), 0.25); assert.equal(I.clampZoom(99), 6); assert.equal(I.clampZoom(99, 5), 5); assert.equal(I.clampZoom(NaN), 1); assert.equal(I.clampZoom(2), 2);
});
test('pinch scale follows finger distance and ignores a degenerate start', () => {
  assert.equal(I.scaleFromDistances(100, 200), 2); assert.equal(I.scaleFromDistances(100, 50), 0.5);
  assert.equal(I.scaleFromDistances(3, 300), 1, 'fingers that start almost together must not explode the zoom');
});
test('wheel/trackpad factor: smooth, bounded, symmetric', () => {
  assert.ok(I.wheelFactor(-10, 0) > 1 && I.wheelFactor(10, 0) < 1);
  assert.ok(Math.abs(I.wheelFactor(10, 0) * I.wheelFactor(-10, 0) - 1) < 1e-9);
  assert.ok(I.wheelFactor(-100000, 0) <= Math.exp(120 * 0.0105) + 1e-9, 'one huge event cannot jump more than a bounded step');
  assert.ok(I.wheelFactor(-3, 1) > I.wheelFactor(-3, 0), 'line-mode wheels count more per tick');
});
test('after zooming, the page point that was under the fingers stays under the fingers', () => {
  // page 600x800 at (20,20); fingers at (320,420) => nx=.5, ny=.5. zoom x2 -> new rect 1200x1600; the layout origin stays where the scroll left it
  const startRect = { left: 20, top: 20, width: 600, height: 800 }, f = { x: 320, y: 420 };
  const nx = (f.x - startRect.left) / startRect.width, ny = (f.y - startRect.top) / startRect.height;
  const newRect = { left: 20, top: 20, width: 1200, height: 1600 };
  const s = I.scrollForFocal({ nx, ny, newRect, fx: f.x, fy: f.y, scrollLeft: 0, scrollTop: 0 });
  assert.equal(s.left, 20 + .5 * 1200 - 320); assert.equal(s.top, 20 + .5 * 1600 - 420);
  // simulate the scroll: rect moves by -scroll; the focal content point must land on the fingers
  const after = { left: newRect.left - s.left, top: newRect.top - s.top };
  assert.equal(after.left + nx * newRect.width, f.x); assert.equal(after.top + ny * newRect.height, f.y);
  // fingers that also panned 40px right: content must end under the NEW finger position
  const s2 = I.scrollForFocal({ nx, ny, newRect, fx: f.x + 40, fy: f.y, scrollLeft: 0, scrollTop: 0 });
  assert.equal(newRect.left - s2.left + nx * newRect.width, f.x + 40);
});
test('double tap toggles between fit and a deeper zoom', () => {
  assert.equal(I.doubleTapTarget(1, 1), 2.2); assert.equal(I.doubleTapTarget(2.2, 1), 1); assert.equal(I.doubleTapTarget(1.05, 1), 2.2);
  assert.equal(I.doubleTapTarget(1, 5), 6, 'never beyond the maximum');
});
