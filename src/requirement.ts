// Requirement drafts shared by the New and Edit screens. Pure TypeScript (unit-tested with Node).
import type { NewRequirement, Requirement } from "./api/types.ts";

export type Draft = Omit<Requirement, "quantity"> & { quantity: number | null };

export const emptyDraft = (destination = "Germany"): Draft => ({ title: "", quantity: null, unit: "pcs", destination, target_price: null,
  target_currency: "USD", target_price_unit: "", reference_url: "", needed_by: "", sample: "not_specified", accept_similar: false,
  specs: "", branding: "", packaging: "", monthly_volume: null });

/** Only send fields the buyer filled in; HIOAsk applies defaults for the rest. */
export function toRequirement(d: Draft): NewRequirement {
  const out: NewRequirement = { title: d.title.trim(), quantity: d.quantity ?? 0, unit: d.unit.trim() || "pcs", destination: d.destination.trim() };
  for (const k of ["reference_url", "needed_by", "specs", "branding", "packaging", "target_currency", "target_price_unit"] as const) if (d[k].trim()) out[k] = d[k].trim();
  if (d.target_price != null) out.target_price = d.target_price;
  if (d.monthly_volume != null) out.monthly_volume = d.monthly_volume;
  if (d.sample !== "not_specified") out.sample = d.sample;
  if (d.accept_similar) out.accept_similar = true;
  return out;
}

/** HIOAsk requires specs or a reference link (images alone are accepted only on single creates with conversation images). */
export const draftValid = (d: Draft) => Boolean(d.title.trim() && d.quantity && d.quantity > 0 && d.destination.trim() && (d.specs.trim() || d.reference_url.trim()));
