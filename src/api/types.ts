// Response shapes of the HIOBuy Gateway RFQ API (HIOAsk OpenAPI 0.7.1) as this demo's backend relays them.
// `your_ref` is added by the demo backend: your own reference without the demo prefix.

export type RfqStatus =
  | "new" | "reviewing" | "awaiting_clarification" | "sourcing" | "quoted"
  | "revision_requested" | "accepted" | "unable_to_source" | "closed" | "cancelled";
export type SampleRequirement = "not_specified" | "none" | "preferred" | "required";

export interface Requirement {
  title: string;
  quantity: number;
  unit: string;
  destination: string;
  target_price: number | null;
  target_currency: string;
  target_price_unit: string;
  reference_url: string;
  needed_by: string;
  sample: SampleRequirement;
  accept_similar: boolean;
  specs: string;
  branding: string;
  packaging: string;
  monthly_volume: number | null;
}

export interface Attachment { id: string; filename: string; content_type: string; content_path: string; kind?: "image" | "document"; size?: number }
export interface Question { id: string; text: string; created_at: string }

export type FeeKind = "sample" | "tooling" | "service" | "shipping" | "other";
export interface Fee { kind: FeeKind; label: string; amount: number | null; confirmed: boolean; note: string }
export interface QuoteOption {
  id: string; label: string; plan: string; match_type: "exact" | "similar" | "custom"; image_id: string | null;
  sku: string; specs: string; differences: string; quantity: number; unit: string; unit_price: number; currency: string;
  moq: number | null; lead_time: string; packaging: string; incoterm: string; shipping: string; notes: string;
  fees: Fee[]; confirmed_total: number; pending_fees: number;
}
export type QuoteStatus = "sent" | "accepted" | "rejected" | "revision_requested" | "superseded" | "expired" | "withdrawn";
export type DecisionAction = "accepted" | "rejected" | "revision_requested";
export interface Quotation {
  id: string; number: string; version: number; based_on_req_version: number; status: QuoteStatus; is_stale: boolean;
  valid_until: string; terms: string; provider_name: string; response_time_promise: string;
  options: QuoteOption[]; attachments: Attachment[]; sent_at: string; decided_at: string | null;
  decision: { action: DecisionAction; option_id: string | null; reason: string } | null;
}

export interface Rfq {
  id: string; number: string;
  external_ref: string | null; your_ref: string | null; external_batch_ref: string | null; batch_id: string | null;
  status: RfqStatus; source: "api" | "staff" | "inquiry"; req_version: number; requirement: Requirement;
  attachments: Attachment[]; open_questions: Question[]; latest_quotation: Quotation | null;
  conversation_id: string | null; closed_reason: string | null; public_reason: string | null;
  created_at: string; updated_at: string; version: number;
}

export interface RequirementChange { version: number; changed: { field: keyof Requirement; from: unknown; to: unknown }[]; note: string; at: string }


export interface Message {
  id: string; sender_type: "customer" | "staff"; recalled: boolean; content: string; created_at: string | null;
  attachments: { id: string; content_type: string; filename: string }[];
}

export interface DemoEvent {
  seq: number; event_id: string; type: string; rfq_id: string | null; conversation_id: string | null;
  summary: { status: string | null; version: number | null; quotation_version: number | null };
  created_at: string | null; received_at: string; deliveries: number;
}
export interface ApiCall { seq: number; at: string; method: string; path: string; status: number; ms: number; code: string | null }

export type AppIdentity =
  | { ok: true; app_name: string; environment: string | null;
      rfq: { enabled: boolean; read: boolean; write: boolean; webhook_configured?: boolean } | null;
      inquiry: { read: boolean; write: boolean } | null }
  | { ok: false; code: string };
export interface Session { visitor: { label: string }; csrf_token: string; ref_prefix: string; webhook_configured: boolean; demo_mode: boolean; app: AppIdentity }

export type NewRequirement = Partial<Requirement> & { title: string; quantity: number; unit: string; destination: string };
