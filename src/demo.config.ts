// Integrator-side copy for this demo. Everything here is synthetic: no real customers, orders or products.
import type { Draft } from "./requirement";

export const demoConfig = {
  /** How your app names the sourcing service to buyers. Quotations also carry HIOAsk's configured provider name. */
  providerName: "Sourcing team",
  appName: "Northwind Supply",
  responseTimePromise: "The sourcing team replies with a quotation or questions, usually within 1–2 business days.",
  defaultDestination: "Germany",
};

/** Synthetic sample requests for "Fill with an example". */
export const EXAMPLES: { ref: string; requirement: Partial<Draft> }[] = [
  { ref: "NW-1001", requirement: { title: "Double-wall stainless steel water bottle, 750 ml", quantity: 1000, unit: "pcs", destination: "Germany",
    target_price: 3.2, target_currency: "USD", target_price_unit: "pcs", sample: "required", packaging: "Individual white gift box",
    branding: "Laser-engraved logo, one position", specs: "18/8 stainless steel, powder-coated matte finish in 3 colours (black, sage, sand). Leak-proof bamboo lid. BPA-free. LFGB test report needed." } },
  { ref: "NW-1002", requirement: { title: "Cotton canvas tote bag", quantity: 2000, unit: "pcs", destination: "Netherlands",
    target_price: 1.1, target_currency: "USD", sample: "preferred", accept_similar: true,
    specs: "12 oz natural cotton canvas, 38 × 42 cm, 70 cm handles, one-colour screen print on one side. OEKO-TEX preferred." } },
  { ref: "NW-1003", requirement: { title: "Silicone kitchen spatula set (3 pieces)", quantity: 600, unit: "set", destination: "France",
    sample: "required", packaging: "Kraft card + polybag", specs: "Food-grade platinum silicone, heat resistant to 230 °C, beech wood handles. Colours: grey and terracotta." } },
];
