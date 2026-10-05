// Small, original stroke icons. Decorative SVGs stay out of accessible names.
const paths = {
  relay: '<path d="M4 8h13l-3-3m6 11H7l3 3M17 8l-3 3M7 16l3-3"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  tasks:
    '<rect x="5" y="4" width="15" height="17" rx="2"/><path d="M9 4V2h7v2M9 10l1 1 2-2m2 1h3M9 16l1 1 2-2m2 1h3"/>',
  message:
    '<path d="M21 11a8 8 0 0 1-8 8H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z"/><path d="M7 8h10M7 12h6"/>',
  activity: '<path d="M2 12h4l3-8 6 16 3-8h4"/>',
  folder:
    '<path d="M3 7V5a2 2 0 0 1 2-2h5l3 4h6a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  terminal:
    '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3m6 0h4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  play: '<path d="m8 5 11 7-11 7Z"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
  expand: '<path d="M14 3h7v7M3 14v7h7m4-11 7-7M3 21l7-7"/>',
  collapse: '<path d="M21 10h-7V3M10 21v-7H3m11-4 7-7M3 21l7-7"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  settings:
    '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
  moon: '<path d="M21 13A9 9 0 0 1 11 3a9 9 0 1 0 10 10Z"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  branch:
    '<circle cx="6" cy="5" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="6" cy="19" r="2"/><path d="M6 7v10m12-9a8 8 0 0 1-8 8H6"/>',
  shield:
    '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z"/><path d="m8 12 3 3 5-6"/>',
  alert: '<path d="m12 3 10 18H2Z"/><path d="M12 9v4m0 3v1"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
} as const;

export type IconName = keyof typeof paths;
export const icon = (name: IconName, className = "") =>
  `<svg class="icon ${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
