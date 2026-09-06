// X11 keysym + DOM code tables for the PVE/QEMU VNC console.
// QEMU advertises extended key events, so every key must carry a DOM `code`
// (noVNC maps it to an AT scancode); keysym-only events break some guests.

const XK = {
  BackSpace: 0xff08, Tab: 0xff09, Return: 0xff0d, Pause: 0xff13, Scroll_Lock: 0xff14,
  Escape: 0xff1b, Delete: 0xffff, Home: 0xff50, Left: 0xff51, Up: 0xff52, Right: 0xff53,
  Down: 0xff54, Page_Up: 0xff55, Page_Down: 0xff56, End: 0xff57, Print: 0xff61,
  Insert: 0xff63, Menu: 0xff67, Num_Lock: 0xff7f, F1: 0xffbe, Shift_L: 0xffe1,
  Control_L: 0xffe3, Caps_Lock: 0xffe5, Meta_L: 0xffe7, Alt_L: 0xffe9, Super_L: 0xffeb,
};

const NAMED = {
  enter: [XK.Return, 'Enter'], return: [XK.Return, 'Enter'],
  tab: [XK.Tab, 'Tab'], escape: [XK.Escape, 'Escape'], esc: [XK.Escape, 'Escape'],
  backspace: [XK.BackSpace, 'Backspace'], space: [0x20, 'Space'],
  delete: [XK.Delete, 'Delete'], del: [XK.Delete, 'Delete'], insert: [XK.Insert, 'Insert'],
  home: [XK.Home, 'Home'], end: [XK.End, 'End'],
  pageup: [XK.Page_Up, 'PageUp'], prior: [XK.Page_Up, 'PageUp'],
  pagedown: [XK.Page_Down, 'PageDown'], next: [XK.Page_Down, 'PageDown'],
  up: [XK.Up, 'ArrowUp'], arrowup: [XK.Up, 'ArrowUp'],
  down: [XK.Down, 'ArrowDown'], arrowdown: [XK.Down, 'ArrowDown'],
  left: [XK.Left, 'ArrowLeft'], arrowleft: [XK.Left, 'ArrowLeft'],
  right: [XK.Right, 'ArrowRight'], arrowright: [XK.Right, 'ArrowRight'],
  capslock: [XK.Caps_Lock, 'CapsLock'], numlock: [XK.Num_Lock, 'NumLock'],
  scrolllock: [XK.Scroll_Lock, 'ScrollLock'], printscreen: [XK.Print, 'PrintScreen'],
  print: [XK.Print, 'PrintScreen'], pause: [XK.Pause, 'Pause'], menu: [XK.Menu, 'ContextMenu'],
  ctrl: [XK.Control_L, 'ControlLeft'], control: [XK.Control_L, 'ControlLeft'],
  alt: [XK.Alt_L, 'AltLeft'], shift: [XK.Shift_L, 'ShiftLeft'],
  super: [XK.Super_L, 'MetaLeft'], win: [XK.Super_L, 'MetaLeft'],
  windows: [XK.Super_L, 'MetaLeft'], cmd: [XK.Super_L, 'MetaLeft'], meta: [XK.Meta_L, 'MetaLeft'],
};
for (let i = 1; i <= 24; i++) NAMED[`f${i}`] = [XK.F1 + i - 1, `F${i}`];

// US QWERTY: char -> [DOM code, needs shift]
const SYMBOLS = {
  ' ': ['Space', false], '-': ['Minus', false], '_': ['Minus', true],
  '=': ['Equal', false], '+': ['Equal', true], '[': ['BracketLeft', false],
  '{': ['BracketLeft', true], ']': ['BracketRight', false], '}': ['BracketRight', true],
  '\\': ['Backslash', false], '|': ['Backslash', true], ';': ['Semicolon', false],
  ':': ['Semicolon', true], "'": ['Quote', false], '"': ['Quote', true],
  '`': ['Backquote', false], '~': ['Backquote', true], ',': ['Comma', false],
  '<': ['Comma', true], '.': ['Period', false], '>': ['Period', true],
  '/': ['Slash', false], '?': ['Slash', true], '!': ['Digit1', true],
  '@': ['Digit2', true], '#': ['Digit3', true], $: ['Digit4', true], '%': ['Digit5', true],
  '^': ['Digit6', true], '&': ['Digit7', true], '*': ['Digit8', true],
  '(': ['Digit9', true], ')': ['Digit0', true],
};

export const SHIFT = { keysym: XK.Shift_L, code: 'ShiftLeft' };
export const MOUSE_MASK = { left: 0x1, middle: 0x2, right: 0x4, wheelUp: 0x8, wheelDown: 0x10 };

export function charPlan(ch) {
  if (/^[a-z]$/.test(ch)) return { keysym: ch.codePointAt(0), code: `Key${ch.toUpperCase()}`, shift: false };
  if (/^[A-Z]$/.test(ch)) return { keysym: ch.codePointAt(0), code: `Key${ch.toUpperCase()}`, shift: true };
  if (/^[0-9]$/.test(ch)) return { keysym: ch.codePointAt(0), code: `Digit${ch}`, shift: false };
  if (SYMBOLS[ch]) return { keysym: ch.codePointAt(0), code: SYMBOLS[ch][0], shift: SYMBOLS[ch][1] };
  if (ch === '\n' || ch === '\r') return { keysym: XK.Return, code: 'Enter', shift: false };
  if (ch === '\t') return { keysym: XK.Tab, code: 'Tab', shift: false };
  throw new Error(`Cannot type character ${JSON.stringify(ch)}; console typing is printable ASCII only`);
}

export function textPlan(text) {
  const value = String(text ?? '');
  if (value === '') throw new Error('No text provided');
  const chars = Array.from(value);
  for (const ch of chars) {
    if (ch.codePointAt(0) > 0x7e) throw new Error('Console typing supports ASCII only; input Chinese through the guest input method (type pinyin, then select the candidate by key)');
  }
  return chars.map(charPlan);
}

export function comboPlan(spec) {
  const parts = String(spec ?? '').split(/[+,]/).map(p => p.trim()).filter(Boolean);
  if (!parts.length) throw new Error('No keys provided');
  return parts.map(part => {
    const name = part.toLowerCase();
    if (NAMED[name]) return { keysym: NAMED[name][0], code: NAMED[name][1], shift: false };
    if (Array.from(part).length === 1) return charPlan(part);
    throw new Error(`Unknown key name: ${part}`);
  });
}
