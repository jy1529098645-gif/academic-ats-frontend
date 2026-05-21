// Twitter card image — same banner as the OG image. Twitter / X render
// `summary_large_image` cards at the same 1200×630, so producing a
// separate asset would just be a maintenance burden. Re-export the
// opengraph-image module so both file conventions point at the same
// rendered output.
export { default, alt, size, contentType } from "./opengraph-image";
