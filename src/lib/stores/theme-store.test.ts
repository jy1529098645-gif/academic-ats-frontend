import { describe, it, expect, beforeEach } from "vitest";
import { THEME_STORAGE } from "@/lib/themes";
import { useThemeStore, hydrateThemeStore } from "./theme-store";

// Smoke tests for the theme store — verify the first-time-visitor
// safeguards still hold (fresh browser → default blue, interaction →
// customized flag lands, hydration replays persisted choice).

describe("theme-store", () => {
  beforeEach(() => {
    window.localStorage.clear();
    // Reset store to fresh state between tests.
    useThemeStore.setState({
      mode: "day",
      dayThemeId: "light",
      nightThemeId: "dark",
    });
  });

  it("defaults to Daylight Blue day mode", () => {
    expect(useThemeStore.getState().mode).toBe("day");
    expect(useThemeStore.getState().dayThemeId).toBe("light");
    expect(useThemeStore.getState().nightThemeId).toBe("dark");
  });

  it("flipping mode marks the user as customized and persists", () => {
    expect(window.localStorage.getItem(THEME_STORAGE.customized)).toBeNull();
    useThemeStore.getState().setMode("night");
    expect(useThemeStore.getState().mode).toBe("night");
    expect(window.localStorage.getItem(THEME_STORAGE.customized)).toBe("1");
    expect(window.localStorage.getItem(THEME_STORAGE.mode)).toBe("night");
  });

  it("hydration is a no-op when customized flag isn't set", () => {
    // Seed leftover values as if a previous session had them; without the flag
    // the store must ignore them so a fresh visitor always sees blue.
    window.localStorage.setItem(THEME_STORAGE.mode, "night");
    window.localStorage.setItem(THEME_STORAGE.dayTheme, "day-sand");
    window.localStorage.setItem(THEME_STORAGE.nightTheme, "night-amber");
    hydrateThemeStore();
    expect(useThemeStore.getState().mode).toBe("day");
    expect(useThemeStore.getState().dayThemeId).toBe("light");
    expect(useThemeStore.getState().nightThemeId).toBe("dark");
  });

  it("hydration replays persisted values once customized flag is set", () => {
    window.localStorage.setItem(THEME_STORAGE.customized, "1");
    window.localStorage.setItem(THEME_STORAGE.mode, "night");
    window.localStorage.setItem(THEME_STORAGE.dayTheme, "day-sand");
    window.localStorage.setItem(THEME_STORAGE.nightTheme, "night-amber");
    hydrateThemeStore();
    expect(useThemeStore.getState().mode).toBe("night");
    expect(useThemeStore.getState().dayThemeId).toBe("day-sand");
    expect(useThemeStore.getState().nightThemeId).toBe("night-amber");
  });

  it("setTheme dispatches by id (back-compat with legacy setTheme shim)", () => {
    useThemeStore.getState().setTheme("night-amber");
    expect(useThemeStore.getState().mode).toBe("night");
    expect(useThemeStore.getState().nightThemeId).toBe("night-amber");
  });
});
