// ─────────────────────────────────────────────────────────────────────────────
// Theme registry — single source of truth for every theme the app supports.
//
// How it works:
//   • Each theme has an id (matches `<main data-theme={id}>`) plus a human
//     label and a short blurb for the settings picker.
//   • Themes are grouped into two categories — `day` and `night`. The main
//     toggle button in the header only flips between categories. The exact
//     theme inside each category is picked in the Settings → Appearance panel.
//   • Adding a new theme is a 3-step operation:
//        1. Drop a new `[data-theme="<id>"] { ... }` block in globals.css
//           defining every `--ats-*` token.
//        2. Register the id here under the right category.
//        3. Nothing else — every component already reads from the tokens.
// ─────────────────────────────────────────────────────────────────────────────

export type ThemeMode = "day" | "night";

export type ThemeDescriptor = {
  id: string;             // data-theme value, e.g. "dark" | "light" | "night-amber"
  label: string;          // Settings picker label
  mode: ThemeMode;        // day or night — decides which list it appears in
  swatches: [string, string, string]; // three colour swatches for the picker preview
  blurb?: string;         // one-line description
};

export const THEME_REGISTRY: ThemeDescriptor[] = [
  {
    id: "light",
    label: "Daylight Blue",
    mode: "day",
    swatches: ["#DEE8F1", "#F4F8FB", "#2563EB"],
    blurb: "Default light theme — blue-gray canvas, white panels.",
  },
  {
    id: "day-sand",
    label: "Warm Paper",
    mode: "day",
    swatches: ["#F2EBDA", "#FBF6E8", "#E59616"],
    blurb: "Warm sand canvas with bright orange accents — archival library feel with more pop.",
  },
  {
    id: "day-mint",
    label: "Morning Mint",
    mode: "day",
    swatches: ["#E4F1EA", "#F5FAF6", "#047857"],
    blurb: "Cool mint canvas with emerald accents — fresh and clinical.",
  },
  {
    id: "day-pink",
    label: "Cherry Blossom",
    mode: "day",
    swatches: ["#FDE6EC", "#FFF4F7", "#EC4899"],
    blurb: "Soft rose canvas with cherry-pink accents — gentle springtime mood.",
  },

  {
    id: "dark",
    label: "Midnight Blue",
    mode: "night",
    swatches: ["#040B19", "#071224", "#3B82F6"],
    blurb: "Default dark theme — deep navy canvas, blue accents.",
  },
  {
    id: "night-amber",
    label: "Amber Noir",
    mode: "night",
    swatches: ["#0A0A0A", "#141414", "#F5A524"],
    blurb: "Crisp black canvas with amber accents — a high-contrast evening mood.",
  },
  {
    id: "night-emerald",
    label: "Emerald Noir",
    mode: "night",
    swatches: ["#071210", "#132521", "#34D399"],
    blurb: "Deep forest canvas with emerald accents — quiet botanical mood.",
  },
  {
    id: "night-rose",
    label: "Rose Quartz",
    mode: "night",
    swatches: ["#1A0F1C", "#221528", "#F472B6"],
    blurb: "Deep plum canvas with rose accents — soft dusk mood.",
  },
  // Aurora Prism temporarily disabled (rim-gradient animation has flicker / layout bugs).
  // Keep the CSS block in globals.css so re-enabling is a one-line registry change.
  // {
  //   id: "night-prism",
  //   label: "Aurora Prism",
  //   mode: "night",
  //   swatches: ["#0A0818", "#22D3EE", "#F472B6"],
  //   blurb: "Obsidian canvas with a shifting rainbow rim — panels glow with spectral light.",
  // },
];

export function themesByMode(mode: ThemeMode): ThemeDescriptor[] {
  return THEME_REGISTRY.filter(t => t.mode === mode);
}

export function themeById(id: string): ThemeDescriptor | undefined {
  return THEME_REGISTRY.find(t => t.id === id);
}

export function defaultThemeFor(mode: ThemeMode): ThemeDescriptor {
  return themesByMode(mode)[0] ?? THEME_REGISTRY[0];
}

export const THEME_STORAGE = {
  mode:      "ats-theme-mode",        // "day" | "night"
  dayTheme:  "ats-theme-day",         // id of the day theme the user last picked
  nightTheme:"ats-theme-night",       // id of the night theme the user last picked
  // "1" once the user has explicitly touched any theme control (day/night
  // toggle or Settings → Appearance). Until this flag is set we show the
  // default blue themes even if other keys happen to be in localStorage —
  // that way first-time visitors always see the intended Midnight-Blue /
  // Daylight-Blue palette.
  customized:"ats-theme-customized",
} as const;
