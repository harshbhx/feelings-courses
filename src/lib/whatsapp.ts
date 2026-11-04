import { course } from "../data/course";
import { site } from "../data/site";

export const DEFAULT_MESSAGE = course.comingSoon
  ? "Hi Urmi, I have a question about the online courses."
  : "Hi Urmi, I have a question about the makeup course.";

/** A wa.me link with an optional prefilled message. Plain anchor, no JS needed. */
export function whatsappLink(message: string = DEFAULT_MESSAGE): string {
  return `https://wa.me/${site.whatsappNumber}?text=${encodeURIComponent(message)}`;
}
