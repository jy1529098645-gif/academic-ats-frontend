// Minimal i18n stub. The advanced version of this app has a full
// translation system; the free public-beta tier ships English only.
// `useT` returns an identity translator so components ported from the
// advanced version compile and run unchanged — every `t("Year")` call
// just yields "Year" literally. If i18n is added later the
// implementation flips in place without touching call sites.
export function useT(): (key: string) => string {
  return (key: string) => key;
}
