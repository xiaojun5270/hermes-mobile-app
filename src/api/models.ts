// src/api/models.ts
//
// Model read/switch surface, per docs/contracts/models.md.
//
// `GET /api/model/info` and `POST /api/model/set` are bound to the profile the
// backend process runs as (no profile parameter) — i.e. the gateway's default
// profile. A switch writes config.yaml and applies to NEW sessions only; a
// running chat keeps its model (use the /model slash command in-chat for that).
import type { RestClient } from './restClient';

export interface ModelCapabilities {
  supports_tools?: boolean;
  supports_vision?: boolean;
  supports_reasoning?: boolean;
  context_window?: number;
  max_output_tokens?: number;
  model_family?: string;
}

export interface ModelInfo {
  model: string;
  provider: string;
  auto_context_length: number;
  config_context_length: number;
  effective_context_length: number;
  /** Best-effort from models.dev — may be `{}`. */
  capabilities: ModelCapabilities;
}

export interface ModelPricing {
  /** Pre-formatted $/Mtok strings, e.g. "$3.00". */
  input: string;
  output: string;
  cache: string | null;
  free: boolean;
}

/** Picker hints gating the fast-toggle / reasoning controls. */
export interface ModelHints {
  fast: boolean;
  reasoning: boolean;
}

export interface ProviderRow {
  /** Value to send back as `provider` when switching. */
  slug: string;
  name: string;
  is_current: boolean;
  is_user_defined: boolean;
  /** Curated model ids (≤50). Empty on unconfigured skeleton rows. */
  models: string[];
  total_models: number;
  source: string;
  authenticated: boolean;
  // Unconfigured skeleton rows only:
  auth_type?: string;
  key_env?: string;
  warning?: string;
  // Best-effort extras (openrouter / nous / novita):
  pricing?: Record<string, ModelPricing>;
  capabilities?: Record<string, ModelHints>;
  free_tier?: boolean;
  /** Paid models a free-tier Nous account cannot pick. */
  unavailable_models?: string[];
}

export interface ModelOptionsResponse {
  providers: ProviderRow[];
  model: string;
  provider: string;
}

export interface StaleAuxSlot {
  task: string;
  provider: string;
  model: string;
}

export interface SetModelResponse {
  ok: boolean;
  /** Expensive-model guard: 200 + ok:false — re-POST with confirm_expensive_model:true. */
  confirm_required?: boolean;
  confirm_message?: string;
  scope?: string;
  provider?: string;
  model?: string;
  base_url?: string;
  gateway_tools?: string[];
  stale_aux?: StaleAuxSlot[];
}

export function getModelInfo(r: RestClient): Promise<ModelInfo> {
  return r.get<ModelInfo>('/api/model/info');
}

export function getModelOptions(r: RestClient): Promise<ModelOptionsResponse> {
  return r.get<ModelOptionsResponse>('/api/model/options');
}

/** Switch the main model. Applies to new sessions only (default profile). */
export function setMainModel(
  r: RestClient,
  provider: string,
  model: string,
  confirmExpensive = false,
): Promise<SetModelResponse> {
  return r.post<SetModelResponse>('/api/model/set', {
    scope: 'main',
    provider,
    model,
    confirm_expensive_model: confirmExpensive,
  });
}

/** Short display name: trailing path segment of a slash-namespaced model id. */
export function modelDisplayName(modelId: string): string {
  if (!modelId) return '未配置';
  const idx = modelId.lastIndexOf('/');
  const tail = idx >= 0 ? modelId.slice(idx + 1) : modelId;
  return tail || modelId;
}

/** One-line pricing hint, or null when the row carries no pricing for the model. */
export function pricingLine(pricing: ModelPricing | undefined): string | null {
  if (!pricing) return null;
  if (pricing.free) return '免费';
  const parts: string[] = [];
  if (pricing.input) parts.push(`输入 ${pricing.input}`);
  if (pricing.output) parts.push(`输出 ${pricing.output}`);
  if (parts.length === 0) return null;
  return `${parts.join(' · ')} / 百万词元`;
}

/** Capability badges for a model, from picker hints. */
export function hintBadges(hints: ModelHints | undefined): string[] {
  const out: string[] = [];
  if (hints?.fast) out.push('快速');
  if (hints?.reasoning) out.push('思考过程');
  return out;
}

/** Compact context-window label: 200000 → "200K context". */
export function formatContext(tokens: number): string | null {
  if (!Number.isFinite(tokens) || tokens <= 0) return null;
  if (tokens >= 1_000_000) {
    return `${trimDecimal(tokens / 1_000_000)}M 上下文`;
  }
  if (tokens >= 1000) {
    return `${trimDecimal(tokens / 1000)}K 上下文`;
  }
  return `${Math.round(tokens)} 上下文`;
}

/** True when a free-tier Nous account cannot pick this (paid) model. */
export function isModelUnavailable(row: ProviderRow, modelId: string): boolean {
  return row.unavailable_models?.includes(modelId) ?? false;
}

/** Summary badges for the current model's capabilities (info endpoint shape). */
export function capabilityBadges(caps: ModelCapabilities | undefined): string[] {
  const out: string[] = [];
  if (caps?.supports_reasoning) out.push('思考过程');
  if (caps?.supports_vision) out.push('视觉');
  if (caps?.supports_tools) out.push('工具');
  return out;
}

function trimDecimal(n: number): string {
  const fixed = n.toFixed(1);
  return fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed;
}
